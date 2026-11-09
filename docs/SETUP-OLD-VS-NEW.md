# First-time setup (setup key) – old process vs new simplified process

The program has no licence or activation step. "Registration" is the one-time **Set up your company** screen,
protected by a **setup key** on internet-facing installs so a stranger cannot claim the site before you do.
Security is unchanged: the key is still required, still compared in constant time, and wrong guesses are now also
throttled. Adding staff logins afterwards (Settings → Users & access) works as before.

## Old process (0.2.3)

| # | Step | What made it confusing |
|---|---|---|
| 1 | Render generated a long random key (e.g. `kQ3_vZ8-Lm2PxR7tYw0aB1c`) **every time the service started** | A restart or redeploy changed the key, so a key copied earlier stopped working |
| 2 | Open Render → Logs and search for a line starting `Setup key:` | The key sat in the middle of a long line with notes in brackets; older lines showed old keys |
| 3 | If the Blueprint was used, the key was instead under Environment as `SETUP_KEY` | Two different places to look, depending on how the service was created |
| 4 | Open the site; fill in setup key, company, prefix, name, email, password, **confirm password**, price book | The key was only checked when the whole form was submitted |
| 5 | Press Create company | A wrong key gave one long error at the bottom; the whole form had to be checked again |
| 6 | Signed in | No pointer to what to do next |

Typical result: 6 steps, two possible key locations, a key that could change part-way through, errors found only at
the end, and a key that was hard to type (mixed case, `_` and `-`, look-alike characters).

## New process (0.3.0)

| # | Step | What changed |
|---|---|---|
| 1 | Render → your service → **Logs**: a framed banner shows **FIRST-TIME SETUP KEY: 7KQM-2HXP-9DWR** | One place to look. A short key in groups of four, with no look-alike characters (no 0/O or 1/I) |
| 2 | Open the site, paste the key, press **Check key** (or Enter) | The key is checked straight away: "✓ Key accepted" or a clear message under the box. Capitals, spaces and dashes do not matter |
| 3 | Company name (job prefix fills itself in), your name, email, password (with **Show**), price book | Confirm-password box removed (Show replaces it); password rule turns green when met; each problem is shown under its own box |
| 4 | Press **Create company and sign in** | Signed in, with a message saying the next step: add your team in Settings → Users & access |

What else changed behind the scenes:

- The key is **made once and saved on the data disk**, so it stays the same through restarts and redeploys until setup
  is finished, then it is deleted. (An environment `SETUP_KEY`, if you set one, still takes priority.)
- `render.yaml` no longer creates a separate `SETUP_KEY`, so Blueprint and manual services behave the same way.
- If someone types a wrong key, the logs print the banner again, so the newest log line always shows the right key.
- Wrong keys are limited to 5 tries per 15 minutes per address (the same rule as signing in).
- "Where do I find the setup key?" on the setup screen lists the four clicks in Render.
- The setup screen opens with the new **Material + Labour cost book** selected.

## Side by side

| | Old | New |
|---|---|---|
| Places the key could be | Logs or Environment | Logs only (or your own `SETUP_KEY`) |
| Key survives a restart | No | Yes, until setup is done |
| Key format | 20 random characters, mixed case and symbols | 12 characters, `XXXX-XXXX-XXXX`, capitals and digits only |
| When a wrong key is found | After filling in the whole form | Straight away, with Check key |
| Password entry | Type twice | Type once, with Show/Hide |
| Error messages | One message at the bottom | Under the box that needs fixing |
| Guessing protection | Key length only | Key length and 5 tries per 15 minutes |
| Steps | 6 | 4 |
