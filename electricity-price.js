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

function GenerateResponse(allPrices) {
	// allPrices contains electricity prices for every hour today,
	// and might have prices for tomorrow too if they are available.

	// Find the price for the current hour
	const now = new Date();
	const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
	const priceData = allPrices.find(item => 
		new Date(item.DateTime).getTime() === currentHour.getTime()
	);
	if (!priceData) { // Shouldn't happen unless API is messing up
		return 'Electricity price is not available for the current hour.';
	}

	let currentHourPriceData = priceData;
	let output = `The current electricity price is ${Math.round(currentHourPriceData.PriceWithTax * 1000) / 10} cents.`;

	// Check if allPrices contains prices for tomorrow
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	const hasTomorrowPrices = allPrices.some(item => 
		new Date(item.DateTime).toDateString() === tomorrow.toDateString()
	);

	// Find the lowest price from the next hour onwards, comparing to current hour's price
	const nextHour = new Date(currentHour);
	nextHour.setHours(nextHour.getHours() + 1);
	const lowestPriceData = allPrices.reduce((lowest, item) => {
		const itemTime = new Date(item.DateTime).getTime();
		if (itemTime >= nextHour.getTime()) {
			const itemPrice = item.PriceWithTax;
			const lowestPrice = lowest ? lowest.PriceWithTax : itemPrice;
			return !lowest || itemPrice < lowestPrice ? item : lowest;
		}
		return lowest;
	}, null);

	if (lowestPriceData && lowestPriceData.PriceWithTax < currentHourPriceData.PriceWithTax) {
		const lowestPrice = Math.round(lowestPriceData.PriceWithTax * 1000) / 10;
		const lowestTime = new Date(lowestPriceData.DateTime);
		const isTomorrow = lowestTime.toDateString() !== now.toDateString();
		const dayInfo = isTomorrow ? 'tomorrow' : 'today';
		const timeStr = lowestTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		output += ` The cheapest price will be ${lowestPrice} cents ${dayInfo} at ${timeStr}.`;
	}
	else {
		output += ` It will not get any cheaper ${hasTomorrowPrices ? 'today or tomorrow' : 'today'}.`;
	}

	return output;
}

module.exports = { GetElectricityPrice };
