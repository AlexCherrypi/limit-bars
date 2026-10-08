# limit-bars

Claude Code plugin that shows the 5-hour and 7-day rate limits live as two bars
above the prompt. Each bar is coloured by usage (green < 70 %, yellow < 90 %,
red from 90 %), and the reset time of each window sits at the right edge, with
the time left in brackets:

```
5h ███████████████░░░░░░░░░░░░░░░░░░░░░░  41% 13:00           (1h 17m)
7d ███████████████████████░░░░░░░░░░░░░░  63% Mi 14.10. 02:00 (5d 14h)
```

The figures come from the session itself (`session.measure`), so they move
whenever a response reports new limits; a minute tick keeps the countdown going
and drops a window to 0 % once its reset time has passed.

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
