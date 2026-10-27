# The assistant home screen

The home page of the dashboard is now an assistant first screen. The chat is the center. The old panels are in the Systems Deck.

## Layout

The page has four parts:

- The HUD bar. It shows the core state, the working engines, the time, and the system pill.
- The tab rail. The first tab is "Core". The other tabs are smaller.
- The core stage. It has the AI core, a greeting, and the chat.
- The Systems Deck. It is closed at first.

## The AI core

The core shows one of four states. Each state has a word and a color:

- Online is cyan.
- Degraded is gold.
- Offline is red.
- Thinking is violet. It shows while a reply streams.

The state comes from `coreState()` in `dashboard/lib/core.ts`. It uses the age of the last pulse and the provider health.

## The system pill

The red banner is now a pill, such as `SYS_WARNING No pulse in 227 min`. Click the pill to read the detail and to open Actions. The pill uses the same rules as the old banner in `lib/keeperBanner.ts`.

## The Systems Deck

Click the System Monitor bar to open the deck. The tabs are:

- Overview: the clock, the pulse, the quota, the task queue, and the run history.
- Daily Brief: the Morning Operational Brief with Read aloud.
- Co-Processors: each provider as a co-processor with a role, such as Reasoning Engine.
- God's Eye: the globe with orbit rings and particles.
- Schedules: the schedules, the activity, and the cluster panels.

Only the open tab renders. A closed deck does not poll the Worker. A link such as `/?deck=brief` opens a tab. The command palette also opens each tab.

## Voice input

The chat has a Voice input button when the browser supports speech recognition. The browser hears the audio. Some browsers send it to their own service. TITAN starts the recognition only after a click and stores no audio.

## Theme and fonts

The Eclipse theme now uses an obsidian ground with electric cyan and stark gold. The other themes keep their colors. The glow and the blur turn off in the OLED and High contrast themes. All motion stops when the visitor asks for reduced motion.

The fonts are system fonts. The page does not load a font from another host. The display font stack names Orbitron and Rajdhani first.
