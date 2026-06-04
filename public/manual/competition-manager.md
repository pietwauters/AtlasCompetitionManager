# Competition Manager Guide

Atlas is a fencing competition management system designed to run pool rounds and direct elimination brackets on competition day. This guide walks you through the full workflow from first setup to final results.

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
One stage of a competition — either a pool round or a direct elimination bracket. A competition typically has one or two pool rounds followed by one DE round. Each round produces a ranking that seeds the next round.

**Strip / Piste**
The physical fencing strip. Atlas calls these *strips* throughout the interface; fencers and referees will know them as pistes. Each strip can be connected to a scoring apparatus via OPP2 (see Appendix C).

**Seed**
A fencer's starting rank within a round, derived from their national ranking or from the results of the previous round. Lower numbers are better — seed 1 is the highest-ranked fencer.

---

## 2. Before Competition Day

This section covers everything to prepare in the days before the event: clubs, fencer records, and verifying the start list. Do this in advance — competition morning is not the right time to add 40 fencers.

### 2.1 Clubs and NOCs

Before adding fencers you need the clubs and nationalities in place, because fencer records reference them.

**Clubs** are managed from the **People** page via the navigation bar. Clubs have a name and an optional short code. Add one club per entry — there is no bulk import for clubs.

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

### 3.1 Creating a tournament

### 3.2 Creating a competition (weapon, gender, age category)

### 3.3 Adding competitors

### 3.4 Seeding from national ranking

### 3.5 Manual seed adjustments

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

---

### 4.6 Closing the round and advancing fencers

The **✓ Close round** button is enabled only when every bout in every pool has a result. While bouts remain, the button shows *Bouts remaining: N* as a reminder.

When you click **Close round**, Atlas:
1. Saves the final standings permanently
2. Applies the advancement rule from the rule document (for example, advance the top 70%)
3. Marks each competitor as *advanced* (shown in green) or *eliminated* (shown in red)

The round status changes to *finished*. Advancing competitors carry their seeding into the next round; their V/M, indicator, and touches scored are used to seed the subsequent pool round or DE bracket.

> **Reopening a round:** if you need to correct a score after closing, click **Reopen round** at the top of the round page. This clears the saved rankings and advancement decisions but keeps all the scores. Re-enter or correct any bout, then close again.

---

## 5. Running a Second Pool Round

### 5.1 Creating a follow-on pool round

### 5.2 Combined seeding across pool rounds

---

## 6. Running Direct Elimination

### 6.1 Creating a DE round

### 6.2 Reading the bracket

### 6.3 Byes and their placement

### 6.4 Entering scores and advancing winners

### 6.5 Simulating results (testing / demo)

---

## 7. Results

### 7.1 Viewing the final results page

### 7.2 How ranks are assigned

### 7.3 Pool-eliminated fencers

---

## 8. Running Multiple Competitions Simultaneously

### 8.1 Strip pipeline overview

### 8.2 Assigning strips across competitions

---

## Appendix A — CSV Import Format

## Appendix B — Keyboard and Navigation Tips

## Appendix C — Strips and OPP2

### C.1 Defining strips

### C.2 Connecting to the MQTT broker

### C.3 Building a strip pipeline

### C.4 Assigning referees to strips
