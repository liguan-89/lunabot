# The rail of Clouds and its ＋

Once a person has two places or more in all (This computer counts while it is
a place; their Clouds, their teams' Clouds, servers they connected by hand),
the sidebar's top capsule switches between them: a places popover over the
window, and ＋ buys another Cloud or adds a server of their own. With one
place there is no switcher, and the window looks as before.

The rail is the window's own chrome, not a page's: this app's page `/rail` in a
view of its own (electron/chrome-rail.mjs), which covers the window while the
places popover or a sheet of its own is open, whatever place's page the window
shows and whatever that server runs. `/rail` is a small page of its own
(`rail.html`, `src/rail.tsx`): the popover's list, its sheets, the skin and the
person's language, not the app.
Nothing here needs a real Luna Bot Cloud account, a payment or the Electron app.

## Contract

- The desktop session may list every Cloud of the person's (`clouds`, at most
  20, contract v1 `CloudEntry`). An older Admin sends none, and the session's
  `cloud` and `teams` say everything exactly as before.
- Each Cloud the person owns besides My Cloud is a saved place of its own,
  named and coloured by the Admin, opened like a team's Cloud: the window pairs
  it through the Admin's `pairing` with that Cloud's id and takes only a grant
  for its own address. My Cloud stays the one home.
- The person opens the places popover with the capsule at the left of the
  sidebar's top row, right after the macOS traffic lights, on the same spot
  either way. It is there only while the window has two places or more.
- The page beside the rail offers that button through `window.ogb.rail`
  (`state`, `openPopover`, `onState`; its main frame only, and a server's page
  only from the person's click), and learns only whether there is a rail and
  whether its popover is open.
- The rail's list carries names, colours and states, never an address, and goes
  only to the rail's own page. No place's page reads it, not even this
  computer's or a Cloud's; a page learns only that the window has one. A
  circle opens only a place main listed, by its id, through main's own switch,
  and only from the person's click.
- A click on a circle is taken at once: the place clicked is marked from that
  click, pending, with its name on a shell over the page while main opens it
  (Waking My Cloud… while it wakes), and any other click replaces it on the
  spot, even one back to the place on screen. Main ends what the earlier click
  had under way; a server restart that can't stop leaves the window on the place
  the person chose last, and the rail stays up through it.
- Buying another Cloud sends the plan, a name and a swatch to the Admin, which
  answers with a checkout this app opens in the browser; the sheet then follows
  the payment and the setup. An Admin that sells one Cloud per account (no
  `clouds`, `canAdd` false, or no such route) is the calm "One Cloud per
  account for now".
- The place on screen tints the top of its sidebar in its colour, faintly
  (`.place-tint`, stronger in dark skins, a thin line with reduced
  transparency, none with forced colours); no colour, no tint. Every place
  starts plain. Settings → Appearance changes it with the same six swatches,
  the plain one named None: a Cloud's on the Admin
  (`PATCH /api/cloud/desktop/clouds/:id`, its owner or its team's admins; a
  member sees it locked), This computer's and a server's connected by hand in
  this app (`environments.json`: This computer's as `localColor`, beside the
  saved places, whether or not the app is signed in). An Admin without that
  route changes nothing and says so.
- The window's own rail changes the colour of every place it lists, whatever
  that place's server runs (an older server's page has no such setting): a
  right-click on a circle, or on its row past eight, opens that place's menu
  with the six swatches. The same rules decide where it is kept
  (`workspaces:recolor`, the rail's own page only, an id main listed); a
  signed-in server not connected here is changed on the Admin. This computer's
  circle wears its colour and has the same menu.
- The person's own servers and computers that signed in with their account come
  in the same list (`managed: false`, on a server, with or without an address).
  They are never a Cloud of theirs to pair with or lend to: the rail shows them
  with a server mark, offline with when they were last seen, one already
  connected here as that saved place, one reachable but not connected with its
  pairing steps, and one only reachable on its own network with nothing to
  open.

## This Mac, once My Cloud is home

Once a person's bots moved to My Cloud, this computer's own copy is frozen and
is never a place again. The rail then shows This Mac (This PC on Windows and
Linux) first, beside My Cloud: a separate place on this computer, with its own
bots. A click starts it fresh in a folder of its own beside the data folder
(`~/.lunabot-profiles/default`, a profile by its stable id; more profiles
would be more folders there), on the same address, one server at a time, as a
local environment switch does. Nothing moves either way, the frozen copy keeps
its marker and its bots, and the move's code never reaches the profile. A line
on its page says the bots from before are on My Cloud and that an older copy
comes in from Settings → Backups, until its ✕ closes it for good in that
workspace, or by itself once it was shown on three days or a week went by. My
Cloud on the rail goes back; the profile keeps running, so This Mac is one
click again. A launch opens the place open when the app last closed (My Cloud,
another Cloud, This Mac or another workspace, a server saved by hand); one that
can't open now (removed, ended, not answering in a few seconds) is My Cloud
instead, with no dialog, and This Mac when My Cloud doesn't run either.
This computer stays lent to My Cloud throughout: lending follows the sign-in,
and only the clean workspace for nobody who can reach the bots stops it. People
with no Cloud see no change.

```sh
node --test electron/clean-workspace.node-test.mjs electron/home-window-profile.node-test.mjs electron/home-window-clean.node-test.mjs electron/cloud-rail.node-test.mjs electron/lending-target.node-test.mjs electron/start-place.node-test.mjs electron/home-places.node-test.mjs
pnpm exec vitest run src/components/PlacesRail.test.ts src/components/HomeLine.test.ts
LUNABOT_UI_E2E=1 pnpm exec vitest run scripts/testing/rail-profile-ui.e2e.test.ts
```

`scripts/testing/rail-profile-ui.e2e.test.ts` runs main's own handlers in a
headless Chrome (`launchHomeWorld` with `profiles`): My Cloud a real Cloud-mode
server with the bots, this computer its real frozen server until This Mac
restarts it on the profile's folder, the rail's own page in a tab of its own,
and this computer really lent to My Cloud on the window's session. It clicks
This Mac on the rail (an empty place, the line, the marker untouched), then My
Cloud (the Cloud's bots), then This Mac again (what was made there is still
there, with no restart), watching the lent link every 50 ms all the while: it
never drops. Each picture is the window as it shows them: the page, with the
rail's see-through view over it while a sheet of the rail's is open.

## More workspaces on this computer, and the cloud badge

＋ offers New workspace on this computer first, to everyone with the rail (and
in the Server menu where there is no rail yet). It asks a name (Work, then
Personal, then Workspace 2 and on) and a colour, then opens it fresh: another
profile under `~/.lunabot-profiles/<id>`, listed with its name, colour and
creation time in `~/.lunabot-profiles/profiles.json` (This Mac, `default`,
is its first entry, kept as it was). One runs at a time: opening another waits
for the work under way in the one that runs (as the move waits for it, at most
a minute, the circle saying so), then stops it as a quit does and starts the
next. Once My Cloud is home every workspace is on the rail; with no home the
named ones sit after This computer, which stays the data folder. A workspace's
menu renames it, changes its colour and removes it, asked first; removing the
open one moves the window to My Cloud (or This computer) and stops its server
before its folder goes to the Trash. Every Cloud's tile has a small cloud at its
corner, and a screen reader hears "…, Cloud"; a named workspace's has a laptop
and a server of the person's own its server mark.

```sh
node --test electron/local-profiles.node-test.mjs electron/cloud-rail.node-test.mjs electron/environments.node-test.mjs
pnpm exec vitest run src/components/PlacesRail.test.ts src/components/PlaceAddSheet.test.ts src/components/HomeLine.test.ts
LUNABOT_UI_E2E=1 pnpm exec vitest run scripts/testing/rail-profile-ui.e2e.test.ts
```

The UI test walks every path through the real pages: ＋ with Escape, Close and
Back at each step, an empty and a taken name, a new workspace opening fresh,
This Mac, Work and My Cloud in every order, a switch while a turn runs (the
circle waits, the turn finishes there and its reply is there on return), two
quick clicks, Rename, Colour, Remove with Cancel, removing the open one and the
last one, an app restart while a workspace is open, the rail past eight, the
badge in the light and dark looks, and, in a second world with no Cloud, the
Server menu's New workspace and the rail appearing with a second place. It
watches the lent link every 50 ms throughout and checks that the frozen copy's
server never starts.

## Automated fixtures

```sh
node --test electron/cloud-list.node-test.mjs electron/cloud-account-clouds.node-test.mjs electron/cloud-rail.node-test.mjs electron/chrome-rail.node-test.mjs electron/home-window.node-test.mjs electron/place-look.node-test.mjs electron/desktop-prefs.node-test.mjs
pnpm exec vitest run src/components/PlacesRail.test.ts src/components/ChromeRail.test.ts src/components/ChromeRailToggle.test.ts src/components/Sidebar.header.test.ts src/components/cloud-buy/AddCloudFlow.test.ts src/components/PlaceLookCard.test.ts
```

The account tests answer as a loopback Admin, with and without `clouds`. The
rail tests load the production preload and check which page gets the list,
which ids open, and that a circle, ＋, checkout and a colour change act only
from a click. The colour tests check who may change a place's colour and where
it is kept, from its own page and from the rail's menu, that nothing is saved
when the Admin refuses, and that the tint follows at once.

## Rendered workflow

```sh
node --experimental-strip-types scripts/verify-cloud-rail.ts --shots .omb-scratch/verify-evidence/cloud-rail
```

It starts a disposable fake-engine server with three bots and the real app in
a Vite preview (`scripts/testing/rail-preview.tsx`), answering the desktop
bridge a hosted Cloud's page gets: six places, one being set up, one that needs
its owner, eleven for the list past eight. A headless Chrome in a throwaway
profile photographs the app's page in Advanced and Simple mode (with the
place's tint), the rail's own page by itself for the list past eight, ＋'s
two choices, the steps for a server of one's own, the plans, the name and
colour of a new Cloud and its setup, the person's signed-in servers and the
steps to connect one, and the colour in Settings and in a circle's own menu
for an admin and for a team member, each in the Daylight and Midnight skins.
The `computer` views are this computer's own page on a desktop with no Cloud
instead: the sidebar plain and in a colour, the Appearance card in Advanced
and Simple mode, and its circle and menu on the rail's own page. The
`rail-icons` views collapse the sidebar to avatars, and the `rail-popover`
ones stand in for the window's own rail over the page (the rail's own page in
a view of its own, its places popover open). The script fails if the sidebar's
button for the rail is not on the same spot with the popover closed and open.
`--only rail,look-settings` limits it to some views and `--size 1338x870` sets
the window (1280x800 by default). Without `--shots` it prints the preview's
address and waits for Ctrl-C.

This computer's card, with no colour yet
(`evidence/sidebar-look-everyone/`):

![This computer's Sidebar color in Settings, plain](evidence/sidebar-look-everyone/after-card-simple-daylight.png)

The sidebar's button for the rail, on the same spot either way
(`evidence/rail-collapse/`):

![The sidebar's button for the rail on the same spot either way](evidence/rail-collapse/after-button-spot-daylight.png)

This is not production qualification: the places and the purchase are the
preview's fixtures, and no Admin, browser checkout or desktop window is
involved.
