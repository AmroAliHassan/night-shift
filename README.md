# night-shift

Goodnight and Goodmorning for Claude Code. Press **Goodnight** before you go to sleep, and Claude carries on as your co-pilot through the night. Press **Goodmorning** when you are back for a full report of what it did.

## What Goodnight does

- **Claude decides for you.** Questions are answered for you. Claude takes its recommended option and logs each decision, with its reason and the other options, in a night log.
- **The work keeps going.** When a turn ends, the mod sends "carry on". It stops when Claude reports the work done or blocked, at the spend cap (US$25 of Claude usage by default), or at the turn limit (80 by default).
- **Direction stays yours by default.** With **Hold for me**, Claude prepares design and route choices but leaves them for you. With **Claude decides**, it takes them too and logs the alternatives, so you can switch in the morning.
- **Red lines all night:**
  - nothing is sent, posted, published, pushed or shared;
  - nothing is deleted or bought;
  - no settings are changed;
  - new paid spend is held for you. Credits you already approved in the conversation may be used, up to the approved amount.

## What Goodmorning does

The night ends, and Claude writes a morning report:
1. what it finished;
2. every decision and why;
3. where it stopped;
4. what needs you;
5. the spend.

It saves the report beside the night log.

## The look

On the desktop app a bar sits above the prompt:

- **By day:** a sunrise, reading "Day shift · you're in charge · tonight · [Hold for me]".
- **At night:** deep ocean with the night's time, steps, decisions and spend.
- **The switch:** Goodnight | Goodmorning sits attached inside the bar's right end, with the current side filled.
- **A press waits 4 seconds,** so you can cancel a mistaken one. Meanwhile the next sky slides across the bar towards the switch, and the switch flips when it lands.
- **The usage row:** above the bar, context and plan-window meters with a Compact button.
- **Full width:** every bar runs to the band's right edge at any window width.

In the terminal the same row is drawn as plain text.

## Smart keep-warm (with the cache-tax mod)

Claude's prompt cache lasts one hour after the last message. If it runs out, your next message in a big session pays to rebuild it, often a few dollars. The [cache-tax](https://github.com/karanb192/claude-code-mods) mod can keep it warm with one small ping per 50 idle minutes. With cache-tax installed, night-shift decides when that is worth it and does it for you:

- **The usage row shows the cache:** **warm** (with the minutes left), **kept warm** (and for how long), or **cold**.
- **A Warm button sits beside Compact.** It is on **Auto** by default; press it to switch between Auto and Off. Your choice is remembered.
- **Auto keeps a session warm only when that costs less than a cold restart.** One restart costs about as much as 20 pings.
  - **A big session** (50k+ tokens) stays warm for 6 hours after your last message. That is seven pings at most.
  - **A small session** is left alone: rebuilding it costs cents.
  - **A night shift that stops early** keeps the cache warm until your wake-up time (`wakeAt`, 08:00 by default) if that is within 8 hours. Further off, it does not bother.
  - **A running night shift** needs nothing: its own turns keep the cache warm.
- **cache-tax's own row is folded into this one,** so you see the cache once.
- **A line in the chat:** Auto shows `/keepwarm` there only when it starts or stops warming, not after every message.
- **A `/keepwarm` you type** shows in the row too.

Without cache-tax, the row and the button are simply not shown.

## Install

At the prompt of a terminal session:

```
/plugin marketplace add AmroAliHassan/night-shift
/plugin install night-shift@night-shift
```

From a shell:

```
claude plugin marketplace add AmroAliHassan/night-shift
claude plugin install night-shift@night-shift
```

In the desktop app, where `/plugin` does not run:
1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace** and enter `AmroAliHassan/night-shift`.
3. Choose **Add plugin**.

Restart Claude Code afterwards.

## Commands

- `/goodnight` and `/goodmorning`: the same as the buttons.
- `/night-shift`: the night's status.
- `/night-shift decide` or `/night-shift hold`: set the direction choice.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `nightCap` | 25 | Claude usage, in US$, the night may spend before it stops itself. |
| `maxTurns` | 80 | The most auto-continued turns in one night. |
| `logFolder` | empty | Where the night log and morning report go. Empty: a `.night-shift` folder in the session's project. |
| `showStrip` | on | Draw the bar above the prompt. The commands work either way. |
| `usageRow` | on | Draw the usage meters and Compact. If you use the skins mod, turn its own band row off (`/skin band off`) to avoid two. |
| `wakeAt` | 08:00 | When you are usually back after a night; Auto keeps the cache warm until then after a night shift that stopped early. |

Works well with [savvy-teams](https://github.com/AmroAliHassan/savvy-teams), whose progress band sits under the night bar.
