/**
 * sessionStorage key for the admin session token, shared by every page with
 * a login flow (Admin, Log, Radio, Satellites, Photos, Guestbook, Status,
 * Conditions' solar sync, and the inline tile editor). Logging in on any
 * one of those pages unlocks all the others for the rest of the browser
 * session, since they all read/write this same key.
 */
export const TOKEN_KEY = 'hamstation_admin_token';
