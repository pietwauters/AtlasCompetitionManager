# Referee Guide

The Atlas scoresheet runs in the browser on a tablet at the piste. It connects to the scoring apparatus over Wi-Fi and shows the live bout, previous results, and lets you record card reasons. No app installation is needed — open the browser, navigate to the address, and you are ready.

---

## 1. Getting Started

### 1.1 Opening the scoresheet

On the tablet browser, navigate to:

```
http://openpiste.local:3001/scoresheet.html?piste=N
```

Replace `N` with your strip number (for example `?piste=3` for strip 3). The strip number is printed on the strip assignment card or shown on the phase page by the competition manager.

> **Tip:** bookmark the URL for your strip before the competition starts so you can reopen it quickly if the browser is closed.

---

### 1.2 Connecting to the broker

The scoresheet connects automatically when the page loads. The status bar at the top of the screen shows the connection state:

- **Connected** (green dot) — the scoresheet is receiving data from the apparatus
- **Disconnected** (red dot) — no connection; the scoresheet retries every 5 seconds automatically

If the status stays disconnected after 30 seconds, check that the tablet is on the correct Wi-Fi network. No action is needed beyond that — the reconnect happens automatically.

---

### 1.3 Dark and light theme

The scoresheet defaults to a **dark theme** suited to indoor competition halls. Tap the **☀ Light** button in the status bar to switch to a light theme. The choice is remembered the next time you open the scoresheet on the same device.

---

## 2. The Scoresheet Screen

### 2.1 Status bar

The narrow bar at the top of the screen shows:

- **Strip number** — confirms which piste this scoresheet is tracking
- **Connection indicator** — Connected / Disconnected
- **Slot label** — the name of the current assignment (e.g. *U17 Foil Men · Pool 3*)
- **Theme toggle** button

---

### 2.2 Pool round view

When a pool is assigned to your strip, the scoresheet shows two sections:

**Pool matrix (top)** — the full results grid for the pool, identical to what the competition manager sees. Each cell shows the score of the row fencer against the column fencer. The rightmost columns show victories (V), indicator (Ind), touches scored (TS), touches received (TR), and current rank. Tap the **Pool ▾** header to collapse the matrix if you need more space for the bout list.

**Bout list (below the matrix)** — all bouts in FIE official order. Each row shows the bout number, both fencers' names, and the score. The active bout — the one currently on the piste — is highlighted and expanded automatically.

![Scoresheet in pool mode showing matrix and bout list](images/scoresheet-dark.png)

---

### 2.3 Direct elimination view

In DE mode, the matrix is not shown. The bout list displays the bouts assigned to your strip in order. The active bout is highlighted and expanded; completed bouts are collapsed and show the final score.

---

### 2.4 Active bout detail

Tap an active bout row to expand it (or collapse it). When expanded, the active bout shows:

- **Fencer names and nations** — left and right as assigned by the apparatus
- **Live score** — updates continuously from the apparatus
- **Card chips** — Y (yellow), R (red), B (black) — shown as coloured chips, updated live

Finished bouts show the final score in the collapsed header row. Tap to expand a finished bout and see any card reasons that were recorded during it.

---

## 3. Recording Card Reasons

### 3.1 When the dialog appears

When the apparatus registers a card — yellow, red, or black — the scoresheet detects the change and immediately shows a **card reason dialog** over the screen. You do not need to tap anything to open it; it appears automatically.

The dialog title shows the card colour and the side (← Left or Right →) and the fencer's name below it.

---

### 3.2 Choosing a reason

The dialog shows a grid of reason buttons for the card type and the weapon being fenced. Tap the reason that applies. The reason is recorded and the dialog closes.

If none of the listed reasons fits, type a free-text reason in the **Other reason…** field and tap **Submit**.

---

### 3.3 Group 1 offences (two-step dialog)

For a **red card**, one of the buttons is labelled **Group 1 ▸**. Tapping it opens a second screen listing the specific Group 1 offences. Tap the one that applies. Tap **← Back** to return to the first screen if you need to change your selection.

---

### 3.4 Skipping the reason

If you cannot record the reason immediately — for example because the bout needs your attention — tap **Skip — no reason recorded**. The dialog closes and the bout continues. No reason is stored for that card.

---

### 3.5 What happens if the card is removed

If the referee removes a card using the remote control before you have submitted a reason, the dialog closes automatically and nothing is recorded. This handles the common case where a card is given by mistake and immediately reversed.

---

### 3.6 Viewing recorded reasons

Tap any bout row to expand it. If card reasons were recorded during that bout, they are listed below the score with the card colour, side, reason text, and time.

---

## 4. Troubleshooting

### 4.1 Scoresheet shows "Disconnected"

The tablet has lost its connection to the MQTT broker. The scoresheet retries every 5 seconds — wait a moment and check the status bar. If it does not recover:

1. Confirm the tablet is still on the competition Wi-Fi network
2. Check that the Atlas server is running (ask the competition manager)
3. Reload the page — the scoresheet will reconnect and restore its state from the broker's retained messages

---

### 4.2 Bout list is empty after connecting

The scoresheet is connected but no bout data has arrived yet. This happens when:

- The strip has not been assigned to a pool yet (the competition manager needs to do this)
- The competition manager has not sent the first bout to the apparatus yet (they need to press NEXT on the remote or in Atlas)
- You opened the scoresheet on the wrong piste number — check the URL

---

### 4.3 Live score is not updating

The score display shows **— : —** when no score data has been received yet. Once the apparatus starts a bout and the timer runs, scores appear automatically. If scores stop updating mid-bout:

1. Check the connection indicator — if disconnected, wait for automatic reconnection
2. Check that the apparatus is powered on and connected to the same network
3. If the score recovers after a brief dropout, the display catches up from the next apparatus message automatically
