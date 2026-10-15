// Loads clerk-js for the pages that need an account (issue #65): reads the
// public values from GET /config, adds the script from the instance's
// Frontend API (no bundler), and waits for Clerk.load(). Resolves to
// undefined when sign-in isn't set up, so the rest of the page works as it
// does without it.

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

/** @returns {Promise<any | undefined>} the loaded Clerk, or undefined if not set up. */
export async function loadClerk() {
  const response = await fetch('/config');
  if (!response.ok) {
    throw new Error('Could not load sign-in');
  }
  const config = await response.json();
  if (!clerkConfigured(config)) {
    return undefined;
  }
  await addScript(clerkScriptUrl(config.clerkFrontendApi), config.clerkPublishableKey);
  await window.Clerk.load();
  return window.Clerk;
}
