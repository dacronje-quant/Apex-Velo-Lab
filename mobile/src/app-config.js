/**
 * Build-time settings of the Android app. scripts/build-web.cjs replaces __APEX_BROKER_URL__ with the token
 * broker's URL (APEX_BROKER_URL, or "brokerUrl" in mobile/app-config.json); unbundled (node tests) it is ''.
 * With a broker URL, Strava sign-in is one tap and the rider's own API application moves under Advanced.
 */
// eslint-disable-next-line no-undef
export const BROKER_URL = typeof __APEX_BROKER_URL__ === 'string' ? __APEX_BROKER_URL__ : '';
