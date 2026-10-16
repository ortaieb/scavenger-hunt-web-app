// Loads clerk-js for the pages that need an account (issues #65 and #66):
// reads the public values from GET /config, adds the script from the
// instance's Frontend API (no bundler), and waits for Clerk.load(). Resolves
// to undefined when sign-in isn't set up, so the rest of the page works as it
// does without it. Both are loaded once per page and shared; a failure isn't
// kept, so the next call tries again.

import { clerkConfigured, clerkScriptUrl } from './account-logic.js';

function addScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.clerkPublishableKey = publishableKey;
    script.addEventListener('load', resolve);
    script.addEventListener('error', () => reject(new Error('Could not load sign-in')));
    document.head.append(script);
  });
}

/** Runs `load` once and shares its result, forgetting it if it fails. */
function once(load) {
  let promise;
  return () => {
    promise ??= load().catch((err) => {
      promise = undefined;
      throw err;
    });
    return promise;
  };
}

/** @returns {Promise<{ clerkPublishableKey?: string | null, clerkFrontendApi?: string | null, requireSignIn?: boolean }>} */
export const loadAccountConfig = once(async () => {
  const response = await fetch('/config');
  if (!response.ok) {
    throw new Error('Could not load sign-in');
  }
  return response.json();
});

/** @returns {Promise<any | undefined>} the loaded Clerk, or undefined if not set up. */
export const loadClerk = once(async () => {
  const config = await loadAccountConfig();
  if (!clerkConfigured(config)) {
    return undefined;
  }
  await addScript(clerkScriptUrl(config.clerkFrontendApi), config.clerkPublishableKey);
  await window.Clerk.load();
  return window.Clerk;
});
