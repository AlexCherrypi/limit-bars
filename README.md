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

## Install

```
/plugin marketplace add AlexCherrypi/limit-bars
/plugin install limit-bars@limit-bars
```

The repository is private, so the machine needs read access to it.

## Develop

```
claude plugin validate .
claude plugin test .
```
