/**
 * Public API registration entrypoint.
 *
 * Domain route modules live under ./api; consumers should continue importing
 * from this file so registration remains atomic and backwards compatible.
 */
export * from './api/application-routes.js';
