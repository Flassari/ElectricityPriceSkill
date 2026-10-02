const https = require('https');

function GetElectricityPrice() {
	/* The lines below to use local test data.
		Get new data at https://api.spot-hinta.fi/swagger/ui or via
		curl -X GET "https://api.spot-hinta.fi/TodayAndDayForward?HomeAssistant=true" -H "accept: application/json"
	*/
	// Uncomment the lines below to use local test data
	// const allPrices = require('./test-response.json').data;
	// return Promise.resolve(GenerateResponse(allPrices));

	return new Promise((resolve, reject) => {
		https.get('https://api.spot-hinta.fi/TodayAndDayForward?HomeAssistant=true', {
			headers: { 'accept': 'application/json' }
		}, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				try {
					const allPrices = JSON.parse(data).data;
					resolve(GenerateResponse(allPrices));
				} catch (err) {
					reject(err);
				}
			});
		}).on('error', reject);
	});
}

const TIME_ZONE = 'Europe/Helsinki';
const HOUR_MS = 60 * 60 * 1000;
const VERY_CHEAP_CENTS = 2.5;
const VERY_CHEAP_MIN_HOURS = 4;
const EXPENSIVE_CENTS = 10;
const WINDOW_HOURS = [2, 3];

// All date logic uses Helsinki time, since Lambda runs in UTC.
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

function HelsinkiDate(date) {
	return dateFormatter.format(date); // YYYY-MM-DD
}

function FormatCents(cents) {
	return `${cents.toFixed(1)} cents`;
}

// "2 AM", "2:30 PM", "noon", with " tomorrow" appended when the date is after today.
// For range end times, midnight is spoken as "midnight" and belongs to the previous day.
function FormatTime(date, today, isEndTime = false) {
	let time = timeFormatter.format(date).replace(/\s/g, ' ').replace(':00', '');
	if (time === '12 PM') {
		time = 'noon';
	}
	if (isEndTime && time === '12 AM') {
		return HelsinkiDate(new Date(date.getTime() - 1)) === today ? 'midnight' : 'midnight tomorrow';
	}
	return HelsinkiDate(date) === today ? time : `${time} tomorrow`;
}

// ", in 5 hours" for delay timers, or empty when the slot is 10+ hours away
function FormatHoursFromNow(start, now) {
	const hours = Math.max(1, Math.round((start.getTime() - now.getTime()) / HOUR_MS));
	if (hours >= 10) {
		return '';
	}
	return hours === 1 ? ', in 1 hour' : `, in ${hours} hours`;
}

// Average price of the window starting at index i, or null if it would run past the data or has gaps.
function WindowAverage(slots, i, slotCount, slotMs) {
	if (i + slotCount > slots.length) {
		return null;
	}
	let sum = 0;
	for (let k = 0; k < slotCount; k++) {
		if (slots[i + k].start.getTime() !== slots[i].start.getTime() + k * slotMs) {
			return null;
		}
		sum += slots[i + k].cents;
	}
	return sum / slotCount;
}

// Cheapest window overall, plus the cheapest one starting later today (for the "Otherwise" fallback)
function FindCheapestWindow(slots, hours, slotMs, today) {
	const slotCount = Math.round(hours * HOUR_MS / slotMs);
	let best = null;
	let bestToday = null;
	for (let i = 0; i < slots.length; i++) {
		const average = WindowAverage(slots, i, slotCount, slotMs);
		if (average === null) {
			continue;
		}
		const window = { index: i, start: slots[i].start, average };
		if (!best || average < best.average - 1e-9) {
			best = window;
		}
		if (i > 0 && HelsinkiDate(window.start) === today && (!bestToday || average < bestToday.average - 1e-9)) {
			bestToday = window;
		}
	}
	if (best) {
		best.averageNow = WindowAverage(slots, 0, slotCount, slotMs);
		best.bestToday = bestToday;
	}
	return best;
}

function DescribeWindow(window, label, now, today) {
	if (window.index === 0) {
		return `The cheapest ${label} hour slot is ${FormatCents(window.average)}, starting now.`;
	}
	let text = `The cheapest ${label} hour slot is ${FormatCents(window.average)} at ${FormatTime(window.start, today)}${FormatHoursFromNow(window.start, now)}.`;
	// Best slot is tomorrow, but there's still something cheaper than starting now later today
	const fallback = window.bestToday;
	if (HelsinkiDate(window.start) !== today && fallback && window.averageNow !== null &&
		Number(fallback.average.toFixed(1)) < Number(window.averageNow.toFixed(1))) {
		text += ` Otherwise, today it's ${FormatCents(fallback.average)} at ${FormatTime(fallback.start, today)}${FormatHoursFromNow(fallback.start, now)}.`;
	}
	// if (window.averageNow !== null) {
	// 	const saving = window.averageNow - window.average;
	// 	if (saving >= 0.05) {
	// 		text += ` That's ${FormatCents(saving)} cheaper than starting now.`;
	// 	}
	// }
	return text;
}

// Runs of consecutive slots under the very cheap threshold, at least VERY_CHEAP_MIN_HOURS long.
function FindVeryCheapRanges(slots, slotMs) {
	const ranges = [];
	let runStart = null;
	for (let i = 0; i <= slots.length; i++) {
		const slot = slots[i];
		const continues = slot && slot.cents < VERY_CHEAP_CENTS &&
			(runStart === null || slot.start.getTime() === slots[i - 1].start.getTime() + slotMs);
		if (continues) {
			if (runStart === null) {
				runStart = i;
			}
			continue;
		}
		if (runStart !== null) {
			const start = slots[runStart].start;
			const end = new Date(slots[i - 1].start.getTime() + slotMs);
			if (end.getTime() - start.getTime() >= VERY_CHEAP_MIN_HOURS * HOUR_MS) {
				const maxCents = Math.max(...slots.slice(runStart, i).map(s => s.cents));
				ranges.push({ startIndex: runStart, start, end, maxCents });
			}
			runStart = null;
		}
		// The current slot may start a new run after a break
		if (slot && slot.cents < VERY_CHEAP_CENTS) {
			runStart = i;
		}
	}
	return ranges;
}

function GenerateResponse(allPrices, now = new Date()) {
	// allPrices contains electricity prices for every hour today,
	// and might have prices for tomorrow too if they are available.
	const allSlots = allPrices
		.map(item => ({ start: new Date(item.DateTime), cents: item.PriceWithTax * 100 }))
		.sort((a, b) => a.start - b.start);
	if (allSlots.length === 0) {
		return 'Electricity prices are not available right now.';
	}
	const slotMs = allSlots.length > 1 ? allSlots[1].start - allSlots[0].start : HOUR_MS;

	// Only consider the current slot and onwards
	const slots = allSlots.filter(slot => slot.start.getTime() + slotMs > now.getTime());
	const current = slots[0];
	if (!current || current.start > now) { // Shouldn't happen unless API is messing up
		return 'Electricity price is not available for the current hour.';
	}

	const today = HelsinkiDate(now);
	const sentences = [`The current electricity price is ${FormatCents(current.cents)}.`];

	const [shortWindow, longWindow] = WINDOW_HOURS.map(hours => FindCheapestWindow(slots, hours, slotMs, today));
	// Same spoken average: the 3h slot is just as good, so only report that one
	if (shortWindow && longWindow && FormatCents(shortWindow.average) === FormatCents(longWindow.average)) {
		sentences.push(DescribeWindow(longWindow, `${WINDOW_HOURS[1]}`, now, today));
	}
	else if (shortWindow && longWindow && shortWindow.index === longWindow.index) {
		sentences.push(DescribeWindow(longWindow, `${WINDOW_HOURS[0]} to ${WINDOW_HOURS[1]}`, now, today));
	}
	else {
		if (shortWindow) {
			sentences.push(DescribeWindow(shortWindow, `${WINDOW_HOURS[0]}`, now, today));
		}
		if (longWindow) {
			sentences.push(DescribeWindow(longWindow, `${WINDOW_HOURS[1]}`, now, today));
		}
	}

	for (const range of FindVeryCheapRanges(slots, slotMs)) {
		const from = range.startIndex === 0 ? 'from now' : `from ${FormatTime(range.start, today)}`;
		sentences.push(`It's very cheap, at most ${FormatCents(range.maxCents)}, ${from} until ${FormatTime(range.end, today, true)}.`);
	}

	const hasTomorrowPrices = slots.some(slot => HelsinkiDate(slot.start) > today);
	const lowestToday = Math.min(...slots.filter(slot => HelsinkiDate(slot.start) === today).map(slot => slot.cents));
	if (!hasTomorrowPrices && lowestToday >= EXPENSIVE_CENTS) {
		sentences.push(`Today's prices never go under ${FormatCents(lowestToday)}, wait until the afternoon for next day's prices to update.`);
	}

	return sentences.join(' ');
}

module.exports = { GetElectricityPrice, GenerateResponse };
