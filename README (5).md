# MMN OTT MART relay

A tiny server that talks to your IPTV provider on behalf of the app. Your
provider blocks the app's hosting network, so the app sends its requests here
instead, and this relay forwards them.

## Deploy on Railway

1. Create a new, empty GitHub repository and upload the two files in this
   folder (`server.js` and `package.json`).
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick that
   repository. Railway detects Node.js automatically — no settings needed.
3. When the deploy finishes, open the service's **Settings → Networking** and
   click **Generate Domain**. Copy the domain, e.g.
   `https://mmn-relay-production.up.railway.app`.
4. Visit that domain in a browser — you should see `MMN relay is running`.

## Connect the app

On the app's login screen, paste the Railway domain into the
**Relay server** field, then log in as usual. The app remembers it together
with your login.

## Notes

- The relay has no database and stores nothing; it only forwards requests.
- Keep the domain private — anyone who has it can use your relay.
