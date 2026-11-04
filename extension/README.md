# Steel sign-in transfer

Load this directory as an unpacked Manifest V3 extension. Open **Settings**. Set your relay URL and secret, then save and test the connection. Use HTTPS for remote relays. Use HTTP for localhost, 127.0.0.1, and ::1 only.

## Move site sign-ins

1. Open a site and sign in.
2. Open the extension and grant site access. Check the domain, cookie count, and storage-key count.
3. Select a saved profile or set a new name. Names use 1–64 letters, digits, hyphens, or underscores.
4. Select **Push this site**. Check each result before using the profile in Steel.

The background worker sends data after you close the popup. The badge shows `OK`, `!` for storage warnings, or `ERR` for failures. Open the popup for recovery steps. Results stay in local extension storage and contain domains, counts, and status only.

The page follows the system light or dark theme. You can use the keyboard for all controls. **Alt+Shift+S** and the page context menu push to the last selected profile. Grant site access in the popup first. Change the shortcut at `chrome://extensions/shortcuts`.

## Site access and batch transfer

The extension has no permanent host permissions. It requests relay access when you save settings and site access when you grant a site. The cookies API cannot read a host without the cookies permission and host access.

For a subdomain, open **Parent-domain cookie access** and grant each parent hostname that holds shared sign-in cookies. Chrome can ignore parent cookies when only the current hostname has access. Each grant includes one hostname, not all its subdomains. The list shows parent hostnames, not a guessed public-suffix boundary.

`Push several sites` lists cookie domains with granted access. Search the list, select a maximum of 100 domains, then select **Push selected sites**. The optional **Grant all-site discovery** control requests access to all HTTP and HTTPS sites. It does not send data until you select sites and start a push. Revoke access in Chrome extension settings.

Site pushes include cookies for the hostname and its parent domains, at all cookie paths. Site pushes do not include other sibling domains. Domain rows show raw cookie-domain counts. Parent cookies can be necessary for sign-in.

The worker cannot move partitioned cookies into the current relay. It stops that site with a direct-sign-in instruction. It does not silently discard those cookies.

To move localStorage, keep a tab open at the same origin. Use the same scheme and port. A missing or inaccessible tab causes a storage warning. The extension does not open hidden tabs or send session storage, IndexedDB, password-manager entries, or manual credentials.

## Pinned sync

Select **Pin this site** to save its origin, destination profile, and storage setting. In Settings, enable automatic sync, select an interval from 5 to 1440 minutes, and save. Automatic sync is off by default. Unpin sites in Settings.

Keep Chrome open for alarms to run. An alarm can run late. Each pin uses its saved destination, not the current popup profile. Host access must stay granted. Storage uses an open tab at the pinned origin. The badge reports the result of the full pinned batch, with earlier failures.

## Saved profiles and limits

Open **Saved profile contents** to examine domains and counts. Select **Remove**, then accept the confirmation. Removal changes only the displayed hostname. It ignores the first cookie dot and hostname case. Subdomains and the global credential store stay unchanged. Summaries show no values or storage-key names.

Push merges data. It does not delete expired or removed browser data from a saved profile. Remove a domain before a clean replacement. Saved profiles contain plaintext sign-in data on the relay host. Keep the relay secret private and control access to the profile directory.

Pushes and removals do not update active Steel contexts. Recreate the profile with `create_profile` to load its saved cookies. Supply the initial site URL to load that origin's localStorage after navigation. Other saved storage origins do not load automatically. Some sites let you use a session on one device only, or make you sign in again. Copying cookies cannot remove those controls.

## Verification

Run `bun test` from the repository root for relay and extension unit tests. Run `bun run build`, `bun x tsc --noEmit`, `bun run lint`, and `bun run format:check` for server gates. Check extension code with `bun x oxlint extension/` and `bun x oxfmt --check extension/`.

The headless fixture harness is `extension/tests/browser.mjs`. First bundle `src/relay.ts` as a Node CommonJS module named `relay.cjs` in a scratch directory in `/tmp/opencode/`. Then run `node extension/tests/browser.mjs <scratch-directory>`. It starts a throwaway relay on 127.0.0.1:3921 and a fixture site on 127.0.0.1:3922. It uses no Steel connection or operator browser.

Native optional-permission prompts do not complete in the headless test environment. The harness copies the on-disk extension into scratch. It adds grants for the local fixture hosts to that test manifest. Those hosts are 127.0.0.1, localhost, app.fixture.test, and fixture.test. Chrome maps the fixture.test names to 127.0.0.1.

Production permissions stay optional. Unit tests check the ungranted, granted, and denied request paths. The browser test checks the parent-cookie access boundary before and after a parent hostname grant. It uses new scratch profiles to prevent stale service-worker modules. It removes those profiles after the test. Screenshots contain fixture data only.
