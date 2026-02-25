# Suno Player

A powerful, self-hosted web player and rating tool for [Suno](https://suno.com/) tracks.

If you generate many tracks on Suno and need an efficient way to listen through them, rate them, filter out the trash, and take notes, this tool is for you.

## Features

- **Multi-Session Management**: Organize your tracks into separate sessions with custom names and icons.
- **Fast Rating System**: Quickly rate tracks (🗑️ Trash, 👌 OK, 👍 Good, ⭐ Perfect) with keyboard shortcuts.
- **Auto-Advance**: Seamlessly jumps to the next track in the queue as soon as you rate the current one.
- **Automatic Metadata & Workspace Import**: Import directly from your Suno Workspace ID and auto-fetch album art, prompts, and titles.
- **Session Protection**: Optionally protect your sessions with a password to keep your ratings private.
- **Notes**: Add notes to specific tracks while listening.
- **Export & Download**: Export your session data as JSON or copy a neatly formatted summary of your rated tracks.

## Setup

1. **Clone the repository**
   \`\`\`bash
   git clone https://github.com/your-username/suno-player.git
   cd suno-player
   \`\`\`

2. **Install dependencies**
   \`\`\`bash
   npm install
   \`\`\`

3. **Start the server**
   \`\`\`bash
   npm start
   \`\`\`
   The application will be available at \`http://localhost:3000\`.

## Usage

### Authentication (for Workspace Import)
To import directly from a Suno workspace or fetch track metadata, you need to provide your Suno authentication token.
1. Open the Suno website in your browser and log in.
2. Open Developer Tools (F12) -> Network tab.
3. Refresh the page or click around until you see API requests.
4. Click on a request and find the \`Authorization\` header (it should start with \`Bearer \`).
5. Copy this value and paste it into the "Auth" setup screen in the Suno Player.

### Keyboard Shortcuts
Use keyboard shortcuts in the player for maximum efficiency:
- `1`: Rate Trash
- `2`: Rate OK
- `3`: Rate Good
- `4`: Rate Perfect
- `0`: Clear Rating
- `Space`: Play / Pause
- `N`: Focus the notes field
- `Left Arrow` / `Right Arrow`: Previous / Next track
- `S`: Toggle Shuffle
- `R`: View Results tab

## Data Storage
All sessions, ratings, and notes are saved locally in the \`data/\` folder. No data is sent to external servers other than Suno's API.

## Customization
You can change the default port by setting the \`PORT\` environment variable before starting the server.

\`\`\`bash
PORT=8080 npm start
\`\`\`
