# Organiser guide

You design the hunt before any session exists. You give an area and a theme,
and the **hunt designer**, an AI agent on the game-server, picks real places
from map data, orders them into a walking loop, and writes a clue and a pose
for each. It takes a few minutes.

## Starting a design

1. **Open the designer** on a laptop or a phone: `/designer`. Enter the
   **organiser key** (the game-server's `GAME_SERVER_ORGANISER_KEY`). It's
   kept only in that browser tab and forgotten when the tab closes. **Forget
   key** signs you out.
2. **Fill in *New design***:
   - **Area**: a place the map can find, such as "Chiswick, London". A large
     area is cut down to a walkable size around its centre.
   - **Theme**: what the hunt is about, such as "The Thames and brewing
     history".
   - **Checkpoints**: 3 to 8. The default is 3.
   - **Longest walk (km)**: 0.5 to 10, for the whole loop. The default is 3.
     Teams start at different checkpoints and each walks the loop minus one
     leg, so no team walks further than this.

   Area and theme need 3 to 200 characters each. The page tells you what to
   fix before anything is sent.
3. **Start design**. The draft opens at the top of the page, and you can
   follow it there. It runs on the game-server, so you can close the page
   and come back: **Drafts, newest first** lists every design with its
   status, area, theme, when it started and, once it's finished, what it
   cost. Tap one to open it.

Only one design runs at a time. If one is already running, the page says
*A design is already running*, with **Follow it** to open it. If it says
*The hunt designer isn't switched on on the game-server*, ask whoever runs
the game-server to turn it on.

By default a design stops after 5 minutes and spends at most $1; the
game-server's settings can change both.

## Following a design

While it runs, the draft shows *Designing…*, how long it has been running,
and each step as it happens, with how far into the run it came:

| Step | What the designer is doing |
|------|----------------------------|
| Finding the area | Looking up your area on the map, e.g. "Chiswick, London, England". "(clipped)" means it was cut down to a walkable size; "No area matches" means the map couldn't find it |
| Looking for places | Listing the named, public places in the area, such as memorials, artworks, fountains and parks, e.g. "58 candidate places" |
| Reading about a place | Reading one place's details, such as its inscription or history, to write a clue |
| Measuring the route | Measuring the walk between some places, e.g. "A loop of 3 places, 1410 m" |
| Checking the draft | Checking a draft against the rules: "No problems" when it passes; otherwise the problems, which it then fixes |
| Writing clues and challenges | Only on a test game-server, whose stand-in designer shows four fixed steps and is ready within seconds |

A step can say what went wrong instead, such as "The map data timed out".
That doesn't end the run: the designer tries something else. A step this
page doesn't know is shown by its own name.

The page checks the draft every 2 seconds while it's open and running, and
stops once it's ready or has failed.

## When a design fails

The draft says *Failed* and why:

| The page says | What happened | What to try |
|---------------|---------------|-------------|
| The designer ran out of steps. | It used all its turns without a hunt that meets the rules | Try again, perhaps with fewer checkpoints or a longer walk |
| It reached its spending limit. | It spent its budget without a hunt that meets the rules | As above |
| It took too long. | It was cut off at its time limit, usually because the map data was slow | Try again later |
| It couldn't produce a hunt that meets the rules. | It gave up, often because the area has too few suitable places for the theme | A broader theme, or a fuller area name |
| The designer couldn't start. | The AI service didn't start or failed | Try again later. The game-server's log says why |
| The server restarted during the run. | The game-server shut down or restarted | Start the design again |

Under *Problems from its last attempt* are the rules its last draft broke,
which show what it was stuck on. For example: "Checkpoint 2: Checkpoints 2
and 3 are 90 m apart; keep them at least 150 m apart". The rules are:

- checkpoints at least 150 m apart, and the loop no longer than your walk;
- a clue or pose mustn't give away the place's name;
- a clue fits on a phone screen (up to 300 characters).

**Try again** fills in *New design* with the same request. Change anything
you like, then **Start design**.

## A ready draft

A ready draft lists its checkpoints in walking order, each with the place's
name, its clue and its pose. Reviewing, editing and publishing it as a
session aren't on this screen yet.

The places come from [OpenStreetMap](https://www.openstreetmap.org/). Map
data © OpenStreetMap contributors.

## Keeping the answers secret

A draft's clues, places and poses are the answers to the hunt. The page
shows them only to you, with your key. The browser doesn't keep them, and
the page's address holds only the draft's id. Don't show the screen to
players.

If the page says *That organiser key isn't right*, the key was mistyped or
has changed on the game-server: enter it again. *No connection to the game
server* means the game-server can't be reached. The page keeps trying.
