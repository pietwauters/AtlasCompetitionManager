# Competition Manager Guide

Atlas is a fencing competition management system designed to run pool rounds and direct elimination tableaux on competition day. This guide walks you through the full workflow from first setup to final results.

> Every page has a light/dark theme toggle in the top navigation bar. Atlas remembers your choice per device.

---

## 1. Key Terms

A few words Atlas uses that may not match the terminology you are used to.

**Tournament**
A named series of events, for example *Belgian Championship 2026*. A tournament is mainly an organisational container — it groups competitions together and appears in menus and exports.

**Competition**
One event within a tournament: a specific weapon, gender, and age category, for example *Men's Foil U17*. This is where fencers register, rounds are created, and results are recorded.

**Fencer**
A person in Atlas's database — their name, club, licence number, and national ranking. A fencer exists independently of any competition.

**Competitor**
A fencer entered in a specific competition. Adding someone as a competitor links their fencer record to that competition and assigns them an initial seed. The distinction matters because the same fencer can compete in multiple events, each with their own seed and ranking.

**Round**
One stage of a competition — either a pool round or a direct elimination tableau. A competition typically has one or two pool rounds followed by one DE round. Each round produces a ranking that seeds the next round.

**Strip / Piste**
The physical fencing strip. Atlas calls these *strips* throughout the interface; fencers and referees will know them as pistes. Each strip can be connected to a scoring apparatus via OPP2 (see Appendix C).

**Seed**
A fencer's starting rank within a round, derived from their national ranking or from the results of the previous round. Lower numbers are better — seed 1 is the highest-ranked fencer.

---

## 2. Before Competition Day

This section covers everything to prepare in the days before the event: clubs, fencer records, and verifying the start list. Do this in advance — competition morning is not the right time to add 40 fencers.

### 2.1 Clubs and NOCs

Before adding fencers you need the clubs and nationalities in place, because fencer records reference them.

**Clubs** have their own page — click **Clubs** in the navigation bar. Each club has a name, an optional short name (used on scoresheets), and an optional country code.

![Clubs page with fencer counts and merge option](images/clubs.png)

Click **Add club** at the bottom to create a new entry. Atlas blocks duplicate names case-insensitively — *Club Namur* and *CLUB NAMUR* are treated as the same club.

If you discover two clubs that should be one (a common result of CSV imports from different sources), use **Merge →**. Select the club to keep as the target; all fencers are moved to the target club and the source club is deleted. This is the correct way to fix spelling variants — do not simply delete a club that has fencers.

The **Delete** button is disabled on any club that still has fencers assigned to it.

**NOCs** (National Olympic Committees) are the nationality codes used for international events. A standard list of IOC country codes is pre-loaded; you only need to add custom entries if your federation uses non-standard codes.

---

### 2.2 Adding fencers manually

Go to **People** in the navigation bar. Click **+ Add person**.

Fill in the personal details:

| Field | Required | Notes |
|---|---|---|
| First name | Yes | |
| Last name | Yes | |
| Date of birth | No | Used for age-category eligibility checks |
| Gender | No | Used to filter eligible competitors |
| Nationality | No | Choose from the NOC list |
| Club | No | Choose from the clubs list |

Tick the **Fencer** checkbox to reveal the fencer profile fields:

| Field | Notes |
|---|---|
| Licence | Your federation's licence number — used as the unique key during CSV import |
| Handedness | Left or Right |
| Weapons | Comma-separated: `foil`, `epee`, `sabre` |
| Ranking | National ranking number (lower = better) — used for auto-seeding |
| Points | Ranking points (for display; not used in seeding calculations) |

Click **Save**. The person appears in the list immediately.

A person can hold both the **Fencer** and **Referee** roles at the same time — tick both checkboxes and fill in each profile section.

![People list with filters and add button](images/people-list.png)

---

### 2.3 Importing fencers from CSV

For larger start lists, CSV import is faster than manual entry. On the **People** page, expand the **Import fencers from CSV** section at the bottom.

**Required columns:**

```
first_name, last_name
```

**Optional columns:**

```
date_of_birth, gender, nationality, club, licence, weapons, handedness, ranking, points
```

Column order does not matter as long as the header row is present. The `club` column takes the club name as a string — Atlas matches it to an existing club by name, or creates the club if it does not exist yet.

**Update behaviour:** if a row has a `licence` value that matches an existing fencer, that record is updated in place. If there is no licence, Atlas matches on `first_name + last_name + date_of_birth`. Rows that do not match any existing record are created as new fencers.

Paste your CSV text into the text area and click **Import**. A summary line appears showing how many records were created and updated.

> **Tip:** Export your existing fencer list first (**↓ Export CSV** button in the toolbar) to see the exact column format Atlas uses. This is also useful for keeping a backup or sharing the list with another system.

---

### 2.4 Reviewing and editing fencer records

Use the toolbar filters to find fencers quickly:

- **Search box** — matches on first or last name
- **Club** dropdown — filter to one club
- **Gender** dropdown
- **Weapon** dropdown
- **Role** dropdown — show only fencers or only referees

Click any column header to sort by that column. Click again to reverse the sort.

To correct a record, click **Edit** on that row. The same form used for adding opens with the existing values pre-filled. Click **Save** when done.

> **Before the competition:** check that every fencer who should compete has the correct weapon, gender, and date of birth set. These are the fields Atlas uses to decide who is eligible when you add competitors to a competition. A fencer with the wrong weapon will not appear in the eligible list.

---

## 3. Setting Up a Competition

Everything starts on the **Tournaments & Competitions** page — click **Competitions** or **Tournaments** in the main nav (they share the same page, with two tabs).

---

### 3.1 Creating a tournament

A tournament is optional but recommended if you are running several competitions on the same day — it keeps them grouped in the list and in exports.

Click the **Tournaments** tab, then **+ New tournament**. Fill in the fields you need:

| Field | Notes |
|---|---|
| Name | e.g. *Belgian Championship 2026* |
| City / Country | For display and exports |
| Start / End date | The dates the event runs |
| Organizer | Club or federation running the event |
| Level | e.g. *Regional*, *National*, *International* |

Click **Save**. The tournament appears in the list and is available as a grouping option when you create competitions.

---

### 3.2 Creating a competition

Click the **Competitions** tab, then **+ New competition**.

| Field | Required | Notes |
|---|---|---|
| Name | Yes | e.g. *U17 Foil Men* — shown throughout the app |
| Weapon | Yes | Foil, Épée, or Sabre |
| Gender | Yes | Male, Female, or Mixed/Open — used to filter eligible fencers |
| Date | No | The competition date |
| Tournament | No | Link this competition to a tournament for grouping |
| Age categories | No | Tick one or more; used together with date of birth to filter eligible fencers |

Click **Save**. The competition appears in the list with status *draft*.

> **Age categories** are defined by your federation (e.g. U17 means born no more than 17 years before the competition year). If no age category is selected, all fencers of the right weapon and gender are eligible regardless of age.

---

### 3.3 Adding competitors

Click the competition name to open the competition detail page.

The right panel shows **Eligible fencers** — everyone in Atlas whose weapon, gender, and age match this competition. Use the search box or the club filter to find fencers quickly.

Click **+ Add** next to a fencer's name to register them as a competitor. Their national ranking becomes their initial seed. You can add fencers one at a time or work through the list systematically.

To remove a competitor, click **Remove** next to their name in the competitors list on the left panel.

![Competition detail page with eligible fencers and competitors list](images/competition-detail.png)

> **Tip:** click **⚡ Auto-seed by ranking** after you have added all competitors. Atlas re-assigns seeds in national ranking order (lowest number = best). Do this last — adding more competitors after auto-seeding will place new arrivals at the end of the list.

---

### 3.4 Seeding from national ranking

Click **⚡ Auto-seed by ranking** on the competition detail page. Atlas sorts all registered competitors by their national ranking field (set on each fencer record) and assigns seed 1 to the highest-ranked fencer, seed 2 to the next, and so on.

Fencers with no ranking are placed at the end, in the order they were added.

---

### 3.5 Manual seed adjustments

The seed numbers in the competitors list are editable. Click on a seed number, type the new value, and press Enter. Seeds do not need to be unique at this stage — if you assign the same number to two fencers, Atlas will warn you when you try to create a pool round.

> Once a pool round has been created, changing seeds has no effect on that round's pool assignments. Adjust seeds before creating the first round.

---

### 3.6 Check-in on competition day

Before drawing pools, use the **Check-in** page to record which registered fencers have actually arrived and to mark any withdrawals. This ensures the pool draw reflects the real start list.

**How to get there:** on the competition detail page, click the **Check-in** button near the top. The URL is `/checkin.html?id=<competition-id>`.

The page shows every competitor grouped by club, with a summary bar at the top:

| Indicator | Meaning |
|---|---|
| **Total** | All competitors added to this competition |
| **Present** | Confirmed arrived (green) |
| **Not yet** | No status recorded yet (grey) |
| **Withdrawn** | Marked absent / withdrawn (red, faded) |

**Marking fencers:**

- **Present** — click the green button next to the fencer's name. Click again to revert to "not yet".
- **Absent / Withdrawn** — click the red button. The fencer is flagged as withdrawn and will appear faded. Click again to revert.
- **✓ All present** — marks every non-withdrawn fencer as present in one step. Useful at small events where the whole list arrives.
- **Clear all** — resets all statuses back to "not yet".

Use the search box to find a fencer quickly by name or club. The filter tabs (**All / Not yet / Present / Withdrawn**) let you focus on one group at a time — for example, show only "Not yet" to work through the remaining arrivals.

**What check-in does and does not do:**

- Marking a fencer **withdrawn** sets their status so that Atlas will **exclude them from the pool draw**. Do this before creating the first pool round.
- Marking a fencer **present** is informational only — it does not affect seeding or pool formation.
- Check-in does **not** remove a fencer from the competition. A withdrawn fencer stays visible in the list and can be reinstated if they arrive late. To permanently remove a fencer, use the **Remove** action on the competition detail page instead.
- Late arrivals after pools are drawn cannot be added to an existing round. The pool draw is final once created.

> **Tip:** use the **Not yet** filter as your working view during check-in. As fencers arrive and you mark them present, the list shortens until only withdrawals and no-shows remain.

---

### 3.7 Using a competition format (optional)

For simple competitions, creating rounds one at a time as described in Sections 4–6 works fine. For larger events with a standard multi-stage structure — a Grand Prix format, or two pool rounds combined into one seeding — Atlas can drive the whole thing from a predefined **format**.

On the competition detail page, before any round has been created, a **Competition format (optional)** box appears above the Rounds card (individual competitions only — team competitions don't use formats). The dropdown defaults to **— no format (manual) —**; leave it there for the plain workflow already described in this guide. To use a format, select one:

| Format | Stages |
|---|---|
| One Pool Round then DE | One pool round (advancement % configurable, default 70%), then a final tableau |
| Two Pool Rounds (combined seeding) then DE | Pool round 1 (no elimination), pool round 2, then a tableau seeded on combined stats across both rounds |
| Two Pool Rounds (round 2 seeding) then DE | Same two pool rounds, but the tableau is seeded only from round 2 |
| Pool Round then Level Pools (final ranking) | One pool round, then ranked "level" pools (blocks of 6) whose result *is* the final ranking — no DE |
| FIE Grand Prix | Preliminary Pools (top 16 seeds exempt) → Preliminary Tableau (runs until 32 survivors remain) → Final Tableau (64-fencer bracket combining the 16 exempts, the pool-exempt top 16, and the 32 survivors) |

If the format takes a parameter (only "One Pool Round then DE" does today), a field appears — e.g. **Advancement after pools (%)**. Click **Apply format**. Atlas checks the format is compatible with your current roster size and shows a specific error if not (e.g. *"requires more than 16 competitors for the preliminary pool round"*). While no round has been created yet, a **✕ Remove format** link lets you undo the choice and go back to manual.

**Working through the stages:** once a format is applied, the Rounds card shows a stage plan — one card per stage with its status, type, and projected fencer count. The **+ New round** button is replaced by a stage-specific one, e.g. **+ Preliminary Pools**, then **+ Preliminary Tableau**, then **+ Final Tableau** — click it to open the same pool/DE creation form used elsewhere in this guide, already scoped to that stage's participants.

For a preliminary tableau with a survivor target (the Grand Prix's middle stage), the bracket runs until the target number remain undefeated, then a **Close (N survivors)** button appears on the phase — click it to lock in survivors and eliminated fencers and move on to the next stage. Trying to close early (bouts still pending, or the wrong number of survivors) shows a specific error explaining what's missing.

---

## 4. Running a Pool Round

### 4.1 Creating a pool round

Open the competition detail page and click **+ New round**. Choose **Pool round** from the two options at the top of the form.

**Rule document** — select the rule set that governs this round. The rule document defines the pool sizes Atlas will consider and what percentage of fencers advance at the end. For most club competitions, only one option is available.

**Separation** — choose how Atlas tries to keep fencers apart when forming pools:

| Option | Use when |
|---|---|
| Club | Local or national competitions — fencers from the same club are separated |
| Nationality | International events — fencers from the same country are separated |
| Nationality + Club | FIE standard — separates by nationality first, then by club |

Click **Calculate pool options**. Atlas counts the active competitors and shows every valid way to form pools of that size (for example, 42 fencers can be split into 6 pools of 7 or 7 pools of 6). The recommended option is marked.

Select the formation you want and click **Create pools**. Atlas assigns fencers to pools using FIE serpentine seeding — seed 1 goes to pool 1, seed 2 to pool 2, and so on, reversing direction each pass — and respects the separation rule as closely as possible.

The competition detail page now shows the new round. Click **Open** to go to the round page.

On the round page, click **▶ Activate round** to open the round for scoring. This locks the pool assignments and makes the score entry links available.

![Round page with pool cards and activate button](images/phase-overview.png)

---

### 4.2 Pool formation options

Atlas shows all valid *uniform* formations (all pools the same size) and any valid *mixed* formations (one size differs by one fencer). If the numbers work out cleanly in only one way, only one option is shown.

> **Tip:** If you need to manually move a fencer from one pool to another after creation — for example because a late withdrawal changes the separation — contact the person managing the draw. Pool assignments cannot currently be edited in the UI once the round is created; delete the round and re-create it if a change is needed before scoring starts.

---

### 4.3 Assigning strips to pools

On the round page each pool is shown as a card. A card displays the pool number, the assigned strip, and the assigned referee — or *No strip assigned* / *No referee assigned* if not yet set.

Click **Assign strip/ref** on a pool card to open the assignment panel. Choose a strip and a referee from the dropdowns and click **Save**. The card updates immediately.

Strip assignment is optional for score entry — you can enter scores manually on any device without a strip assignment. Assignments become important when using OPP2: the scoring apparatus on that strip will receive the correct bout list automatically (see Appendix C).

> **Large pools (8+ fencers):** if you are using OPP2, consider distributing the pool across two strips to reduce the total time. This is done through the pipeline builder on the Schedule page, not here — see §8.4.

---

---

### 4.4 Entering scores

Click **Open** on a pool card to open the pool scoresheet. Bouts are listed in FIE official bout order.

![Pool scoresheet with bout list](images/pool-matrix.png)

Each row shows:
- The bout number (FIE order)
- Left fencer's name
- Score input boxes
- Right fencer's name
- An undo button (↩)

**To enter a score:** type the left fencer's score in the left box and press Tab, then type the right fencer's score in the right box. The result is saved as soon as you leave the field. The winning fencer's name turns green.

**Equal scores (tie):** if both scores are the same, a small dropdown appears between the names asking you to pick the winner. This happens when a bout ends in overtime priority. Select the fencer who won priority and the bout is saved.

**Undo:** click the red **↩** button on any finished bout to clear its score and return it to pending. Only the most recent entry can be undone.

Bouts can be entered in any order — you do not need to follow the printed bout sheet sequence.

---

### 4.5 Live rankings

The round page shows a live rankings table below the pool cards. It updates automatically as scores come in; no page refresh is needed.

| Column | Meaning |
|---|---|
| V | Victories |
| V/M | Victory ratio (victories ÷ bouts fenced) |
| Ind | Indicator (touches scored minus touches received) |
| TS | Touches scored |
| TR | Touches received |

Fencers are ranked in order: best V/M first, then best indicator, then most touches scored. The label *(live — not saved yet)* is shown while the round is open to make clear that these standings are provisional.

**Exact ties:** when two or more fencers share identical V/M, indicator, and touches scored, the rank column shows a shared number with a **T** suffix (e.g. *3T*) for every row in the tied block. By default the tied order is arbitrary (alphabetical or random, depending on the Admin setting — see below). If your federation requires a manual fence-off or draw to break the tie, an Admin can enable **"Allow manual tie-break reordering on phase page"** in Admin → Competition Settings; once enabled, an extra ▲ / ▼ column appears on this table for tied rows only, letting you reorder them by hand. Your chosen order is saved and carries into DE seeding.

---

### 4.6 Closing the round and advancing fencers

The **✓ Close round** button is enabled only when every bout in every pool has a result. While bouts remain, the button shows *Bouts remaining: N* as a reminder.

When you click **Close round**, Atlas:
1. Saves the final standings permanently
2. Applies the advancement rule from the rule document (for example, advance the top 70%)
3. Marks each competitor as *advanced* (shown in green) or *eliminated* (shown in red)

The round status changes to *finished*. Advancing competitors carry their seeding into the next round; their V/M, indicator, and touches scored are used to seed the subsequent pool round or DE tableau.

> **Reopening a round:** if you need to correct a score after closing, click **Reopen round** at the top of the round page. This clears the saved rankings and advancement decisions but keeps all the scores. Re-enter or correct any bout, then close again.

---

## 5. Running a Second Pool Round

A second pool round is common in larger competitions — it lets you see everyone fence twice before cutting to DE, and produces a more reliable seeding for the tableau.

### 5.1 Creating a follow-on pool round

Close the first pool round (§4.6). The competition detail page will show the first round with status *finished*.

Click **+ New round**, choose **Pool round**, select a rule document, and click **Calculate pool options**. Atlas automatically uses the final ranking of the previous round as the seeding input — seed 1 in the new round is the fencer who ranked first overall in the previous round.

Everything else works identically to the first pool round: choose pool sizes, set separation, assign strips, enter scores, close. Only advancing competitors from the first round appear in the second round — eliminated fencers do not re-enter.

---

### 5.2 Combined seeding across pool rounds

When you create the DE round after two pool rounds, Atlas offers a choice of seeding method:

**Use last pool round ranking only** — the DE seed is taken from the second pool round results alone. A fencer who had a bad first round but recovered is seeded purely on their second-round performance.

**Combined ranking across all pool rounds** — Atlas aggregates each fencer's V/M, indicator, and touches scored across both rounds and ranks them on the combined totals. This is the FIE standard approach and is fairer to fencers who performed consistently across both rounds.

The choice only appears when there are two or more finished pool rounds. For a single pool round there is nothing to choose — the seeding is always taken from that round's results.

---

## 6. Running Direct Elimination

### 6.1 Creating a DE round

Close all pool rounds first. On the competition detail page, click **+ New round** and choose **DE round**.

Select a rule document. Atlas automatically calculates and displays:

- **N competitors** — the number of fencers who advanced from the pool rounds
- **Tableau size** — the smallest power of 2 that fits N (e.g. 45 fencers → 64-person tableau)
- **Bye count** — the number of byes needed to fill the tableau (64 − 45 = 19 byes)

If two or more pool rounds were finished, the seeding method choice appears here (see §5.2).

Click **Create DE tableau**. Atlas builds the entire tableau immediately — all rounds from the round of 64 through to the final — and automatically scores all bye bouts. The phase opens with status *pending*.

Click **▶ Activate phase** on the DE page to begin scoring.

---

### 6.2 Reading the tableau

The tableau is displayed as columns from left (earliest round) to right (final). Each column is labelled: *Round of 64*, *Round of 32*, *Quarter-final*, *Semi-final*, *Final*.

Each box (bout card) shows two fencers and, once scored, their scores with the winner highlighted. Fencers are identified by name; their seed is shown in the results table at the bottom of the page once bouts are completed.

Click any bout card to open the score panel below the tableau.

---

### 6.3 Byes and their placement

Byes go to the **highest-seeded fencers**. If there are 19 byes in a 64-person tableau, seeds 1 through 19 each receive a bye in the first round and advance automatically to the second round.

Bye bouts are displayed in the tableau with the label *bye* and are already marked finished — you do not need to enter any score for them. The advancing fencer moves into the next round's slot automatically.

> **Why top seeds get byes:** this is FIE standard. Byes reward the best-ranked fencers from the pool rounds; lower-ranked fencers must fence an extra bout to advance.

---

### 6.4 Entering scores and advancing winners

Click a bout card to select it. The score panel appears below the tableau with the two fencers' names and number inputs.

Enter the left score and right score and click **Save score**. The winner advances automatically to the correct slot in the next round — you do not need to do anything else. The next round's bout card updates as soon as the score is saved.

**Ties (overtime):** if both scores are equal, two buttons appear — click the fencer who won priority. The result is saved with equal scores and the selected fencer as winner.

**Undo:** click **↩ Undo** on a finished bout to clear its score and the winner's advancement. This also clears any subsequent scores that depended on this bout (it removes the winner from the next round). Use this to correct a score entry mistake.

> Undo works through the tableau — if a fencer has already won their next bout, you must undo that result first before undoing the earlier one.

---

### 6.5 Simulating results (testing / demo)

Click **🎲 Simulate** to fill in all remaining bouts with random scores. This is useful for testing the tableau or demonstrating the app without real competition data.

Simulate can be run on a partially completed tableau — it only fills bouts that have no result yet.

---

### 6.6 Results table

As bouts are completed, a results table appears at the bottom of the DE page showing the current standings:

| Place | Fencer |
|---|---|
| 🥇 1st | Winner of the final |
| 🥈 2nd | Loser of the final |
| 3rd (shared) | Both semi-final losers — no bronze bout is held unless the rule document specifies one |
| 5th, 6th, 7th, 8th… | Quarter-final losers ranked by their pool-round seed |

The full competition results page (§7) combines these DE results with the pool-eliminated fencers for a complete ranking.

---

## 7. Results

### 7.1 Viewing the results page

The results page is available at any point during the competition — it updates live as bouts are scored. Access it from the **📋 Results** link on the competition detail page or from the DE page.

The table shows every competitor in the competition, ordered by final place, with columns for place, DE seed, name, club, and a note explaining how the rank was determined.

![Final results page](images/results.png)

The page refreshes automatically when new scores come in — no manual reload needed.

---

### 7.2 How ranks are assigned

**Fencers who reached the DE tableau** are ranked by their DE result:

| Place | Assigned to |
|---|---|
| 1st | Winner of the final |
| 2nd | Loser of the final |
| 3rd (shared) | Both semi-final losers |
| 5th, 6th… | Quarter-final losers, ranked by DE seed |
| 9th–16th… | Round of 16 losers, ranked by DE seed |

3rd place is always shared between the two semi-final losers — no bronze bout is fenced unless the rule document explicitly requires one.

Within each eliminated group (everyone who lost in the same round), fencers are ranked by their DE seed — which is itself derived from their pool-round performance. Two fencers who lost in the same round cannot be separated by DE results alone.

**Fencers who were eliminated in the pool rounds** appear below the DE fencers and are ranked by their final pool standing (see §7.3).

---

### 7.3 Pool-eliminated fencers

Not every competitor advances to the DE — the advancement rule in the pool round closes off a percentage of the field. Eliminated fencers are appended to the results table below the DE rankings, in pool-ranking order.

The **Note** column shows which round eliminated them and their pool rank (e.g. *Pool round 1 (rank 28)*). This makes it clear how each fencer's place was determined.

> If you want to produce a printed results sheet, use your browser's print function (Ctrl+P / Cmd+P) from the results page. The sidebar is hidden in print view, giving a clean single-column layout.

---

## 8. Running Multiple Competitions Simultaneously

Atlas can run several competitions at the same time — for example Men's Foil U17 and Women's Épée Senior on the same set of strips. Each strip has an independent schedule called a **pipeline** that determines which bouts it fences and in what order.

> This section requires OPP2-connected apparatus. If you are entering scores manually on the pool scoresheet, strip assignment through the pipeline is not needed — use the simpler **Assign strip/ref** button on the phase page (§4.3) instead.

---

### 8.1 Strip pipeline overview

A pipeline is an ordered list of **slots** for one strip. A slot is one of three types:

- A **pool** — all bouts from one pool, sent to the apparatus in FIE order
- A **DE range** — a selection of bouts from one round of a DE tableau (useful when multiple strips share a DE tableau, each fencing a different portion)
- A **team match** — a full team match (9 relays), see §10

When the referee presses **NEXT** on the apparatus remote, Atlas finds the next pending bout in that strip's pipeline and sends the fencer names and match settings to the apparatus automatically. When all bouts in a slot are done, Atlas advances to the next slot without any manual intervention.

Each slot can carry optional timing information (Start, Min/bout, and an automatically-computed Predicted end), and up to five officiating roles: **Referee**, **Referee 2**, **Video assistant**, **Assessor 1**, **Assessor 2** — see §8.3.

A ⚠ warning appears on a slot if its scheduled start time is earlier than the predicted end of the previous slot, flagging a scheduling overlap.

---

### 8.2 Building a strip pipeline

Open the **Schedule** page from the navigation bar (`/opp2.html`). It's a two-panel layout:

- **Left — Strips.** A grid of every piste with a status dot (green = apparatus online), name, pending-slot count, and scheduled time range. Tick **Hide offline** to declutter. Click a strip to select it.
- **Right — pipeline detail.** Once a strip is selected, its pipeline is shown as a list of slot cards, plus an **Add slot** form at the bottom.

**To add a slot,** fill in the Add slot form: choose the type (**Pool**, **DE range**, or **Team match**), then:

- **Pool** — pick a pool from the dropdown (already-scheduled pools are shown disabled with ⊗ and the strip they're on). If the pool has 8 or more bouts, a **Split bouts across multiple pistes** checkbox appears — see §8.4.
- **DE range** — pick the DE phase, then the round, then the "From bout / To bout" range this strip will fence.
- **Team match** — pick from the active team matches. A match is flagged with a warning if the draw hasn't been done yet or the fencing order isn't fully submitted (see §10.4).

Set a Start time if you want one; **Min/bout** is optional too — leave it blank to use the adaptive default (§8.6). Click **Add slot**.

**To reorder slots:** drag a slot by its ⠿ handle to a new position, or use the **▲ / ▼** buttons in its detail row — both work, drag-and-drop didn't replace the buttons.

**To remove a slot:** click **Remove**. This does not affect any scores already recorded — it only removes the slot from the pipeline. Use **Move to →** in a slot's detail row to shift it to a different strip instead of removing and re-adding it.

Completed slots collapse automatically into a compact *✓ done* row. Click the row to expand it again if you need to review it.

Below the pipeline builder, a **Piste schedule** Gantt chart shows every scheduled slot across all strips on one timeline (blue = pending, green = active, gray = done, with a red "now" line) — useful for spotting overlaps at a glance across the whole competition day.

![Schedule page showing strip pipelines](images/opp2-admin.png)

---

### 8.3 Referee and officiating schedule

Each pipeline slot can carry up to five officials, not just one referee — set them from the slot's detail row on the Schedule page: **Referee**, **Referee 2** (a second referee — common in team competitions), **Video assistant**, **Assessor 1**, **Assessor 2**. All are optional; most slots only need the primary Referee.

**Referee Gantt chart** — at the bottom of the Schedule page, a second Gantt chart shows every official's day on one timeline, one row per person, with each bar labelled by piste and — for anyone other than the primary referee — their role (e.g. *"Piste 3 — Pool A (Assessor 1)"*). This is the fastest way to see whether someone is double-booked.

**Dedicated Referee Schedule page** (`/referee-schedule.html`, linked from the nav bar as **Referees**) gives a fuller, filterable view with two toggles:

- **By piste** — one card per strip, listing its slots with start/end time, assignment, the primary referee, and any other officials in a compact tag row.
- **By referee** — one card per person (referee, video assistant, or assessor — anyone assigned to at least one slot in any role), listing every slot they're involved in with a **Role** column showing which capacity they're serving in for that slot. A separate **Unassigned slots** card lists any slot with no primary referee, so gaps are easy to spot.

Tick **Show completed** to include already-finished slots in either view. Both views auto-refresh every 30 seconds.

---

### 8.4 Multi-strip pool distribution

For pools of 8 or more fencers it is possible to run the pool simultaneously across two or more pistes. Atlas divides the bouts between the strips so that fencers rotate between pistes and no fencer is asked to fence consecutive bouts without rest.

**When to use this:** large pools (8–12 fencers) take a long time on a single strip. Splitting across two strips roughly halves the duration without changing the pool result in any way — every bout is still fenced; the final V/M and ranking are the same.

**Setting it up:**

1. Click **+ Add slot** on the primary strip's card.
2. Select **Pool** and choose the pool from the dropdown.
3. When the pool has 8 or more bouts, a **Multi-strip distribution** section appears below the pool picker.
4. Tick one or more additional strips. A preview line shows the approximate bout count per strip, for example *~18 bouts/strip across 2 strips*.
5. If the selected strips are not consecutive piste numbers, a yellow warning is shown — adjacent pistes are strongly recommended so the referee can easily coordinate between them.
6. Optionally enable **Dynamic reordering** (see below).
7. Set the start time and minutes per bout as usual, then click **Add**.

Atlas creates a pipeline slot on the primary strip and a matching slot on each additional strip. The pool card on the phase page shows a **×2 pistes** badge (or ×3 etc.) to confirm the distribution is active.

**How bouts are distributed:**

Atlas groups the bouts into *waves* — each wave is a maximal set of bouts that can be fenced simultaneously because no fencer appears more than once. Within each wave the bouts are distributed across the strips in round-robin order, with a slight bias toward the strip with fewer bouts so far, producing a balanced split.

Where mathematically unavoidable, a fencer may have zero rest between two consecutive bouts on different strips. These cases are flagged in a notice after adding the slot; the number of flags is shown. In practice the referee can always add a brief pause between those bouts.

> **Adjacent pistes:** always use strips with consecutive numbers (e.g. pistes 3 and 4, not 3 and 6) when distributing a pool. The referee on one strip needs to be able to see and communicate with the referee on the other.

**Pools of 11 or 12 fencers:**

The standard FIE bout order for pools of 11 and 12 has a very uneven rest distribution — some fencers fence back to back many times. For these large pools Atlas automatically uses a circle round-robin order instead, which gives every fencer an equal rest pattern and distributes much more cleanly across two strips. This applies both to single-strip and multi-strip use.

**Dynamic reordering:**

When this checkbox is ticked, Atlas monitors actual progress during the pool and may swap an upcoming bout to a different position if a fencer would otherwise have insufficient rest. The minimum rest is set globally in the OPP2 settings (default: 3 minutes). Dynamic reordering acts within a small look-ahead window of 4 bouts, so swaps are minor — the overall structure of the pool is preserved.

This option is most useful when bouts take significantly different amounts of time (e.g. one strip consistently finishes faster than the other). Disable it if you prefer a fixed, predictable bout sequence.

---

### 8.5 Bulk assignment

Adding pools or DE bouts to strips one at a time is fine for a handful of slots, but for a whole competition's worth of pools it's faster to assign them all at once. Click **⚡ Bulk assign pools / DE** at the top of the Schedule page's strip list.

**Pools tab:** pick a competition. A piste selector appears — tick strips to use (**Select all idle** ticks every free strip in one click; busy strips are highlighted with a ⚠ warning). Set an optional start time. A live preview table matches every pool in the competition to a piste, largest pool first, and flags any pool that couldn't be assigned (not enough pistes selected) in red. Click **Assign N pools**.

**DE rounds tab:** pick a DE phase and round (shown with its bout and bye count, e.g. *"R2 · 6 bouts (2 byes)"*) — a **↻ Same pistes as R&lt;n-1&gt;** shortcut appears if the previous round used specific pistes already. The preview lists each real bout (byes are skipped automatically) matched to a piste round-robin, with each successive wave of bouts getting a later start time. Click **Assign N slots**.

If any selected piste already has pending slots, choose **Append anyway** or **Skip busy pistes** before submitting. Made a mistake? **↩ Undo last bulk assign** removes everything the last bulk operation just created, in one click.

---

### 8.6 Bout timing defaults

Predicted end times (§8.1) need a default minutes-per-bout figure to work from. Admins set this on the **Admin** page, under **Bout Timing Defaults** — a table per weapon (Foil/Épée/Sabre) with a row per gender and separate Pool/DE default columns.

Once a weapon/gender/phase combination has at least 4 completed bouts logged, Atlas automatically switches to a rolling **observed average** instead of the manual default — shown alongside it, and used everywhere the manual default would otherwise apply (including as the "N (auto)" placeholder when adding a slot). Click **Reset averages** on a row to discard the accumulated observations and fall back to the manual figure, for example after changing weapon rules or noticing an outlier skewing the average.

---

## 9. User Accounts and Access

Atlas uses a role-based login system. Different roles are allowed to do different things. Everyone on the local network can read all public data without logging in — login is only required to make changes.

---

### 9.1 Roles and what they can do

There are four roles, in ascending order of authority:

| Role | Typical person | What they can do |
|---|---|---|
| **Referee** | Bout referee | Read all data. Enter and confirm bout scores. |
| **Assistant** | Entrance desk staff | Everything a Referee can do, plus: check in competitors, correct people and club records. |
| **Director** | Competition director | Everything an Assistant can do, plus: create and manage competitions, phases, pools, and bouts; manage strips; build strip pipelines. |
| **Admin** | System administrator | Everything a Director can do, plus: configure and connect the MQTT broker; create, delete, and manage user accounts. |

**Public (not logged in):** anyone on the local network can view all pools, results, tableaux, and schedules without a login. No login is required to follow the competition.

The hierarchy is strict: a Director can do everything an Assistant and Referee can do; an Admin can do everything a Director can do. There is no way to grant a narrower set of permissions within a role.

---

### 9.2 Logging in

All roles use **QR code + PIN** to log in:

1. Open `/login.html` or scan your accreditation badge QR code.
2. The QR code pre-fills your username in the login form — you only need to enter your PIN.
3. Enter your 6-digit PIN and press **Login**.
4. Your session lasts 12 hours. After that you will need to log in again.

If you do not have a QR badge, type your username directly in the login field and enter your PIN.

**Forgot your PIN?** Ask an Admin to reset it. The new PIN is shown once — write it down and change it when you next log in.

---

### 9.3 Managing user accounts (Admin only)

Go to the **Admin** page to manage accounts. From here you can:

- **Create a user** — choose a username and role. A 6-digit PIN is generated and shown once. The user must change it on first login.
- **Reset a PIN** — generates a new PIN shown once. Use this when a user has forgotten their PIN.
- **Delete a user** — permanently removes the account. The user is logged out immediately.

Each user account has a **QR code** that encodes a login link. Click the **QR** button on any account row to display it. Use **Print badge** to open a print-ready badge page for that user, or **Print all badges** to print accreditation badges for everyone at once. Print these before competition day and attach them to accreditation lanyards.

Scanning the badge QR with a phone or tablet opens `/login.html` with the username pre-filled — the user just enters their PIN.

---

### 9.4 QR codes: two types

Atlas generates two distinct kinds of QR code, used for different purposes:

**Accreditation QR codes (Admin page)**
- One per user account.
- Encodes a link to the login page pre-filled with that user's token.
- Printed on accreditation badges and given to referees, directors, and assistants.
- Scanning it lets the person log in quickly without typing their username.
- Requires a PIN — scanning the QR alone does not grant access.

**Piste scoresheet QR codes (Strips page → QR codes)**
- One per fencing strip.
- Encodes a link to the live scoresheet for that strip.
- Intended to be printed and posted at the entrance to each piste.
- Anyone can scan it — no login required. It opens a read-only view showing the current bout, scores, and pool record for that strip.
- Generate and print these before the session starts so referees and spectators can follow along on their phones.

---

## 10. Team Competitions

Atlas supports FIE-style team events — three fencers plus one reserve per team, competing in a 9-relay match. Team competitions are direct-elimination only; there is no team pool phase.

### 10.1 Creating a team competition

Create the competition as in §3.2, but tick **Team competition** in the creation form. This is a property of the whole competition, set once — it can't be toggled per round. Once ticked, the competition detail page reshapes itself: "Competitors" becomes **Registered fencers**, the round picker only offers **Team DE**, and results go to a dedicated team results page (§10.5).

### 10.2 Registering teams

On the competition detail page, first add fencers to the competition as **Registered fencers** (right-hand panel, same as §3.3). Then, in the **Teams** card, click **+ Add team** and give it a name (e.g. *Leonidas A*).

Each team card shows a fencer count (e.g. *3/3 fencers + R*) and a **▼ Members** toggle. Expand it to assign registered fencers into the team via the **— add competitor —** dropdown, choosing a role: **Regular** (up to 3) or **Reserve** (up to 1). Remove a member with the ✕ next to their name.

Once every team's roster is set, click **⚡ Auto-seed teams by ranking** — this ranks teams by the combined seeding of their regular members and is required before creating the tableau (at least 2 seeded teams).

### 10.3 The team DE tableau

Click **Team DE**, then **Create Team DE tableau** (shown once ≥2 teams are seeded, with a live preview like *"8-team tableau (2 byes)"*). This opens `team-de.html`, a standard-looking bracket — *Round of N*, *Semi-final*, *Final* — plus a separate **3rd Place bout** card. Each bracket entry is a full team match (§10.4), not a single bout. The phase header shows *"X / Y matches complete"* and a **Close phase** button, enabled once every match is done, which records the final team rankings. **Simulate all** is available for testing.

### 10.4 Running a team match

Open a match ("Open →" on a ready bracket card) to reach `team-match.html`:

1. **Initial draw** — **Auto draw (random)**, or pick a winner manually and confirm. The winner becomes "Team A" (relay positions 1–3), the loser "Team B" (positions 4–6).
2. **Fencing order** — each side assigns its 3 regular fencers to positions via dropdowns, then clicks **Submit Team A/B order**. Once both sides have submitted, the match goes active.
3. **Relays** — 9 rows, each a 3-minute bout between one fencer per side per the FIE rotation. Enter each relay's touches (Left/Right) and save; a **⏱️ time** checkbox marks a relay that ended on time rather than touches. The **Cumul.** column tracks the running total — each relay has its own target (5, 10, 15 … up to 45 for relay 9), and the match ends the moment either team reaches 45, even mid-relay.
4. **Substitution** — a captain can swap in the reserve for a named position from a chosen relay onward, via **Declare Substitution** — once per team per match.
5. **Tiebreak** — if cumulative scores are still level after relay 9, a **Tiebreak!** banner appears for a one-minute sudden-death bout; record the result by clicking the winning team's name.

**Simulate match** is available for testing.

### 10.5 Team results

The team results page (`team-results.html`) shows Place, Team (name + club), and Members (reserves marked *(R)*). It populates once the Team DE phase is closed — before that it shows a reminder to close the phase first.

### 10.6 Scheduling and live scoring

Team matches are scheduled onto a piste like any other slot (§8.2) — choose **Team match** as the slot type and pick from the active matches. On the referee's live scoresheet, a dedicated banner shows *"Team relay N / 9"*, both team names, the live cumulative score, and that relay's target — so the referee always knows how many touches are needed to end the match.

---

## Appendix A — CSV Import Reference

### A.1 Column reference

| Column | Required | Notes |
|---|---|---|
| `first_name` | **Yes** | |
| `last_name` | **Yes** | |
| `date_of_birth` | No | See format note below |
| `gender` | No | `M`, `F`, or `X` |
| `nationality` | No | IOC 3-letter code (e.g. `BEL`, `FRA`, `NED`) |
| `club` | No | Matched by name; created if not found |
| `licence` | No | Federation licence number — used as the unique merge key |
| `weapons` | No | Comma-separated: `foil`, `epee`, `sabre` |
| `handedness` | No | `R` or `L` |
| `ranking` | No | Integer national ranking |
| `points` | No | Numeric ranking points |

Column order does not matter as long as the header row is present.

### A.2 Date of birth format

> **Important — international date format differences**
>
> Atlas stores and expects dates in **ISO 8601 format: `YYYY-MM-DD`** (e.g. `2005-03-17` for 17 March 2005).
>
> Many national federations and the FIE export dates in country-specific formats:
>
> | Convention | Example | Risk |
> |---|---|---|
> | Day/Month/Year (Belgium, France, UK, …) | `17/03/2005` | **Not accepted** — convert before importing |
> | Month/Day/Year (USA) | `03/17/2005` | **Not accepted** — and easily confused with DD/MM |
> | `YYYY-MM-DD` (ISO 8601) | `2005-03-17` | ✓ Accepted |
> | `DD-MM-YYYY` | `17-03-2005` | **Not accepted** |
>
> If dates import incorrectly (wrong age category, wrong eligibility), a format mismatch is almost always the cause.
> Inspect a few rows before importing a large file. Tools like Excel, LibreOffice, and most scripting languages can reformat dates in bulk.
>
> **Day/Month ambiguity:** a date like `03/05/2005` looks like 3 May in a European file but 5 March in a US file. There is no way for Atlas to detect this automatically — you must know the source convention.

### A.3 Merge behaviour

- If a row has a `licence` value that matches an existing fencer, that record is **updated in place**.
- If there is no `licence`, Atlas matches on `first_name + last_name + date_of_birth`. Both the name and the date must match exactly.
- Rows that do not match any existing record are **created** as new fencers.

> **Tip:** Export your existing fencer list first (**↓ Export CSV** button) to see the exact column format Atlas uses. Use this as a template when preparing an import from an external source.

### A.4 RFC-4180 compliance

The CSV parser follows RFC-4180. Fields containing commas or line breaks must be enclosed in double quotes. A literal double quote inside a quoted field is represented as two double quotes (`""`). The file must be UTF-8 encoded to correctly handle accented characters (é, ü, ñ, …).

## Appendix B — Keyboard and Navigation Tips

## Appendix C — Strips and OPP2

For full coverage of strip pipelines and OPP2 see Section 8.

### C.1 Defining strips

Strips are defined on the **Strips** page. Each strip has a name (e.g. *Green*) and a strip number. The strip number is the identifier used in OPP2 MQTT topics — it must match what the scoring apparatus is configured with.

From the Strips page, click **QR codes →** to open the piste QR code page. This page shows a printable QR code for each strip that links directly to the live scoresheet for that piste (see §9.4).

### C.2 Connecting to the MQTT broker

Open the **Admin** page and scroll to the OPP2 section. Enter the broker URL (default: `mqtt://openpiste.local:1883`) and click **Connect**. Atlas will attempt to reconnect to this broker automatically on every restart.

Only Admin users can connect, disconnect, or change the broker address.

### C.3 Building a strip pipeline

See Section 8 for the full pipeline workflow.

### C.4 Assigning referees to strips

Officials are assigned per pipeline slot on the Schedule page — up to five roles per slot (Referee, Referee 2, Video assistant, Assessor 1, Assessor 2). See §8.3 for the full referee/officiating schedule views and the referee Gantt chart.

---

## Appendix D — Importing from FIE XML

If your federation's registration system (e.g. Engarde) can export a start list as FIE XML, Atlas can import it directly instead of re-entering fencers by hand or preparing a CSV.

On the **Tournaments & Competitions** page, Competitions tab, click **Import FIE XML**. In the dialog:

1. Choose the XML file.
2. Optionally pick **Attach to existing tournament** — leave it on *"— Auto-create from XML —"* to let Atlas create a new tournament from the file's own event details.
3. Click **Import**.

Atlas reports how many fencers were created and updated (and skipped, with any warnings), plus a **Go to competition →** link to jump straight to the newly imported competition.

**Caveats:**
- Only the individual start-list document type (`BaseCompetitionIndividuelle`) is currently supported — other FIE XML document types are rejected with an explanation.
- The import creates the competition and its fencer roster as a **draft** — it does not import pools, DE brackets, or results. Continue from §3.3 onward as normal.
- Weapon is inferred automatically from the file.
- Importing requires Director-level access (§9.1).
