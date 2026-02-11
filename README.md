# GitHub PR Status

A GNOME Shell extension that shows the CI status of your open GitHub pull requests in the top panel.

## Features

- Displays an icon in the top panel reflecting the overall CI state of your open PRs
- Dropdown menu lists each PR with its individual CI status
- Click a PR to open it in your browser
- Desktop notifications when a PR's CI status changes
- Configurable polling interval (60–3600 seconds)
- Persists known states across sessions so you get notified of changes that happened while logged out

## Requirements

- GNOME Shell 49
- A GitHub Personal Access Token with `repo` scope

## Installation

Copy or symlink this directory to your GNOME Shell extensions folder:

```sh
ln -s /path/to/github-pr ~/.local/share/gnome-shell/extensions/github-pr-status@andreicek
```

Compile the GSettings schema:

```sh
glib-compile-schemas schemas/
```

Then restart GNOME Shell (log out and back in on Wayland) and enable the extension:

```sh
gnome-extensions enable github-pr-status@andreicek
```

## Configuration

Open the extension preferences to set your GitHub token and polling interval:

```sh
gnome-extensions prefs github-pr-status@andreicek
```

## License

MIT
