# limit-bars

Claude Code plugin that shows the 5-hour and 7-day rate limits live as two bars
above the prompt. Each bar is coloured by usage (green < 70 %, yellow < 90 %,
red from 90 %), and the reset time of each window sits at the right edge, with
the time left in brackets:

```
5h ███████████████░░░░░░░░░░░░░░░░░░░░░░  41% 13:00           (1h 17m)
7d ███████████████████████░░░░░░░░░░░░░░  63% Mi 14.10. 02:00 (5d 14h)
```

The figures come from two places, and per window the newer one counts:

- **the session itself** (`session.measure`): every response reports the limits,
  so while the model works the bars move with each one;
- **the server**: while no response comes (the session is idle), every 5 minutes
  the bars read the account's usage meter through a short second `claude` (the
  SDK's `get_usage` request, the fetch `/usage` does: no model request, no tokens,
  about 3 s). So usage from other sessions and devices shows as well.

**After an account switch** (a `/login` to another account, an account switcher)
the bars show the new account's figures at once: every 2 seconds they look at
`oauthAccount.accountUuid` in `~/.claude.json` (a `stat`, read only when it
changed) – or wherever Claude Code keeps it: `$CLAUDE_CONFIG_DIR/.claude.json`
where that is set, an older install's `.config.json` in `$CLAUDE_CONFIG_DIR` or
`~/.claude`, `.claude-custom-oauth.json` with `CLAUDE_CODE_CUSTOM_OAUTH_URL`. On a
switch the old account's figures go at once and the new one's are read from the
server right away; until they or a response that counts arrive, the bars stay
empty rather than show the wrong account. A response counts only when its request
went out after the switch and after every request from before it had come back:
those went out under the old account, and their headers bring its limits. A failed
reading for the new account is tried again after 30 seconds, doubling. A file
that is half written or gone for a moment is no switch, and a reading the account
changed under is dropped. What the watch knows is kept for the session, so a
changed option (which reloads the mod) or a replaced hooks worker does not forget
a switch whose new account has not answered yet.

The server is never asked without a claude.ai login (API key, cloud provider), nor
in a session that draws nowhere (`claude -p`, the SDK), nor with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set: Claude Code counts the usage meter
as nonessential traffic, and the bars then go by the session's own figures. An answer from the
engine's cache counts as no reading, and a failed one backs off (5 minutes,
doubling up to an hour; a login without rate limits an hour). A minute tick keeps
the countdown going and drops a window to 0 % once its reset time has passed.

`claude -p` takes an `ANTHROPIC_API_KEY` from the environment over the claude.ai
login, so where the session itself does not run on that key the second `claude`
gets it empty. Claude Code takes the key in a session with you at the prompt
(terminal, VS Code) only once you approved it, and in `-p` and the SDK as it is.
limit-bars tells which by the key's last 20 characters against
`customApiKeyResponses.approved` in `~/.claude.json`, the way Claude Code does; the
key itself is read for nothing else and goes nowhere; where that file cannot be read,
nothing is guessed and the reading waits for the usual back-off. With an
`apiKeyHelper` in your settings the session runs on its key, which the second
`claude` (reading no settings) would not: then the server is not asked – except in
the desktop app, a local agent and a remote session, where Claude Code's own login
wins over the helper.

Those big bars are drawn in the terminal and in the desktop app's Code tab,
with an empty row above them that keeps them apart from the transcript. A little status
line under the prompt shows the same figures in one row:

```
5h ▰▰▰▱▱▱▱▱ 41% ↻13:00 (1h 17m) · 7d ▰▰▰▰▰▱▱▱ 63% ↻Mi 14.10. 02:00 (5d 14h)
```

The `display` option (in `/plugin` → limit-bars → configure) picks which one:

| `display` | Shows |
|---|---|
| `auto` (default) | the big bars where they can be drawn, the little line everywhere else (VS Code, mobile, remote) |
| `big` | only the big bars |
| `little` | only the little line |
| `both` | both, e.g. for a terminal session you also follow remotely |

The `reading` option says how often the server is asked while the session is idle:
`5` (default), `15` or `30` minutes, or `off` (only right after an account switch).

## Install

```
/plugin marketplace add AlexCherrypi/limit-bars
/plugin install limit-bars@limit-bars
```

or from the personal marketplace `alexcherrypi` (`AlexCherrypi/alexcherrypi-plugins`):

```
/plugin install limit-bars@alexcherrypi
```


## Develop

```
claude plugin validate .
claude plugin test .
```
