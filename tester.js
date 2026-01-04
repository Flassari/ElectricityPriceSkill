const { GetElectricityPrice } = require('./electricity-price');

GetElectricityPrice()
	.then(price => console.log(price))
	.catch(err => console.error('Error fetching electricity price:', err));