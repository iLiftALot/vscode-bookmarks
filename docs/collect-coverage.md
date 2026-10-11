# Collect runtime coverage for Node service

1. Remove any old dump directory: `rm -rf ./coverage`
2. Build the app: `npm run build`
3. Start the app with V8 coverage enabled: `NODE_V8_COVERAGE=./coverage node dist/server.js`
4. Exercise the routes or jobs you care about.
5. Stop the app and run: `fallow coverage setup`
6. In CI, after the build, run `fallow coverage upload-inventory` with `FALLOW_API_KEY` set. The upload is what enables the dashboard's Untracked filter (functions that exist but runtime coverage never parsed). Runtime coverage alone only answers `called` vs `never_called`; the static inventory adds the third state.
