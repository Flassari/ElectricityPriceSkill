const { GetElectricityPrice, GenerateResponse } = require('./electricity-price');

// Usage:
//   node tester.js                 Fetch live prices from the API
//   node tester.js test [file]     Run simulated times against local test data (default test-response.json)
if (process.argv[2] === 'test') {
	const file = process.argv[3] || './test-response.json';
	const allPrices = require(file.startsWith('.') || file.includes(':') ? file : `./${file}`).data;
	const day = allPrices[0].DateTime.slice(0, 10);
	for (const time of ['00:30', '03:30', '10:30', '14:30', '22:30', '23:30']) {
		const now = new Date(`${day}T${time}:00+03:00`);
		console.log(`--- ${day} ${time} ---`);
		console.log(GenerateResponse(allPrices, now));
	}
}
else {
	GetElectricityPrice()
		.then(price => console.log(price))
		.catch(err => console.error('Error fetching electricity price:', err));
}
