// app.json holds the app's settings; this adds build-time choices (see the plugin).
const withCleartextForHttpApi = require('../../infra/mobile/cleartext-plugin');

module.exports = ({ config }) => withCleartextForHttpApi(config);
