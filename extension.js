import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import Soup from "gi://Soup";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const GRAPHQL_QUERY = `{
    viewer {
        login
        pullRequests(first: 50, states: OPEN) {
            nodes {
                title
                url
                number
                repository { nameWithOwner }
                commits(last: 1) {
                    nodes {
                        commit {
                            committedDate
                            statusCheckRollup {
                                state
                            }
                        }
                    }
                }
                reviews(last: 30) {
                    nodes {
                        createdAt
                        state
                        author { login }
                    }
                }
                comments(last: 30) {
                    nodes {
                        createdAt
                        author { login }
                    }
                }
            }
        }
    }
}`;

const ICON_MAP = {
  success: "emblem-ok-symbolic",
  failure: "dialog-error-symbolic",
  pending: "content-loading-symbolic",
  error: "dialog-warning-symbolic",
  unknown: "dialog-question-symbolic",
};

const STYLE_MAP = {
  success: "system-status-icon github-pr-success",
  failure: "system-status-icon github-pr-failure",
  pending: "system-status-icon github-pr-pending",
  error: "system-status-icon github-pr-error",
  unknown: "system-status-icon github-pr-unknown",
};

export default class GitHubPRStatusExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._session = new Soup.Session();
    this._cachePath = GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      this.metadata.uuid,
      "ci-state.json",
    ]);
    this._previousStates = this._loadCache();

    Gio._promisify(
      Soup.Session.prototype,
      "send_and_read_async",
      "send_and_read_finish",
    );

    this._icon = new St.Icon({
      icon_name: ICON_MAP.unknown,
      style_class: STYLE_MAP.unknown,
    });

    this._conversationIcon = new St.Icon({
      icon_name: "user-available-symbolic",
      style_class: "system-status-icon github-pr-conversation",
      visible: false,
    });

    const box = new St.BoxLayout({ style_class: "panel-status-indicators-box" });
    box.add_child(this._icon);
    box.add_child(this._conversationIcon);

    this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
    this._indicator.add_child(box);
    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._settingsHandlers = [
      this._settings.connect("changed::github-token", () =>
        this._startPolling(),
      ),
      this._settings.connect("changed::refresh-interval", () =>
        this._startPolling(),
      ),
    ];

    this._startPolling();
  }

  disable() {
    this._stopPolling();

    if (this._settingsHandlers) {
      for (const id of this._settingsHandlers) this._settings.disconnect(id);
      this._settingsHandlers = null;
    }

    this._session?.abort();
    this._session = null;
    this._settings = null;
    this._previousStates = null;
    this._cachePath = null;

    this._indicator?.destroy();
    this._indicator = null;
    this._icon = null;
    this._conversationIcon = null;
  }

  _startPolling() {
    this._stopPolling();
    this._refresh();

    const interval = this._settings.get_int("refresh-interval");
    this._timerId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      interval,
      () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopPolling() {
    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = null;
    }
  }

  async _refresh() {
    const token = this._settings?.get_string("github-token");
    if (!token) {
      this._updatePanelIcon("unknown");
      this._buildMenu(
        null,
        "No GitHub token configured.\nOpen Settings to add one.",
      );
      return;
    }

    try {
      const prs = await this._fetchPRStatus(token);
      if (!this._indicator) return; // disabled while fetching
      this._notifyChanges(prs);
      const overallState = this._getOverallState(prs);
      this._updatePanelIcon(overallState);
      this._updateConversationIcon(prs);
      this._buildMenu(prs, null);
    } catch (e) {
      if (!this._indicator) return;
      console.error(`[GitHub PR Status] ${e.message}`);
      this._updatePanelIcon("error");
      this._buildMenu(null, `Error: ${e.message}`);
    }
  }

  _notifyChanges(prs) {
    if (!this._settings?.get_boolean("notify-on-change")) return;

    for (const pr of prs) {
      const key = pr.url;
      const prev = this._previousStates.get(key);

      if (prev && prev !== pr.ciState) {
        const state = pr.ciState.toLowerCase();
        const label = `${pr.repo}#${pr.number}`;
        Main.notify(`CI ${state}: ${label}`, pr.title);
      }

      this._previousStates.set(key, pr.ciState);
    }

    // Remove entries for PRs that are no longer open
    const currentUrls = new Set(prs.map((pr) => pr.url));
    for (const key of this._previousStates.keys()) {
      if (!currentUrls.has(key)) this._previousStates.delete(key);
    }

    this._saveCache();
  }

  _loadCache() {
    try {
      const [ok, data] = GLib.file_get_contents(this._cachePath);
      if (ok) {
        const obj = JSON.parse(new TextDecoder().decode(data));
        return new Map(Object.entries(obj));
      }
    } catch (_) {
      // Missing or corrupt file — start fresh
    }
    return new Map();
  }

  _saveCache() {
    try {
      const dir = GLib.path_get_dirname(this._cachePath);
      GLib.mkdir_with_parents(dir, 0o755);
      const obj = Object.fromEntries(this._previousStates);
      GLib.file_set_contents(this._cachePath, JSON.stringify(obj));
    } catch (e) {
      console.error(`[GitHub PR Status] Failed to save cache: ${e.message}`);
    }
  }

  _hasUnreadComments(pr, myLogin, lastCommit) {
    const committedDate = lastCommit?.committedDate
      ? new Date(lastCommit.committedDate).getTime()
      : 0;

    const myReviewDates = (pr.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING" && r.author?.login === myLogin)
      .map((r) => new Date(r.createdAt).getTime());
    const myCommentDates = (pr.comments?.nodes ?? [])
      .filter((c) => c.author?.login === myLogin)
      .map((c) => new Date(c.createdAt).getTime());
    const myLatestComment = Math.max(0, ...myReviewDates, ...myCommentDates);

    const threshold = Math.max(committedDate, myLatestComment);

    const otherReviewDates = (pr.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING" && r.author?.login !== myLogin)
      .map((r) => new Date(r.createdAt).getTime());
    const otherCommentDates = (pr.comments?.nodes ?? [])
      .filter((c) => c.author?.login !== myLogin)
      .map((c) => new Date(c.createdAt).getTime());

    return [...otherReviewDates, ...otherCommentDates].some(
      (date) => date > threshold,
    );
  }

  async _fetchPRStatus(token) {
    const body = JSON.stringify({ query: GRAPHQL_QUERY });
    const message = Soup.Message.new("POST", "https://api.github.com/graphql");
    message.request_headers.append("Authorization", `Bearer ${token}`);
    message.request_headers.append("User-Agent", "gnome-github-pr-status");
    message.set_request_body_from_bytes(
      "application/json",
      new GLib.Bytes(new TextEncoder().encode(body)),
    );

    const responseBytes = await this._session.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
    );

    const statusCode = message.get_status();
    if (statusCode !== Soup.Status.OK) {
      if (statusCode === 401) throw new Error("Invalid GitHub token (401)");
      if (statusCode === 403)
        throw new Error("Rate limited or forbidden (403)");
      throw new Error(`GitHub API returned ${statusCode}`);
    }

    const data = JSON.parse(new TextDecoder().decode(responseBytes.get_data()));

    if (data.errors)
      throw new Error(data.errors.map((e) => e.message).join(", "));

    const myLogin = data.data.viewer.login;

    return data.data.viewer.pullRequests.nodes.map((pr) => {
      const lastCommit = pr.commits.nodes[0]?.commit;
      const rollup = lastCommit?.statusCheckRollup;
      return {
        title: pr.title,
        url: pr.url,
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        ciState: rollup?.state ?? "UNKNOWN",
        hasUnreadComments: this._hasUnreadComments(pr, myLogin, lastCommit),
      };
    });
  }

  _getOverallState(prs) {
    if (!prs || prs.length === 0) return "success";

    let hasPending = false;

    for (const pr of prs) {
      switch (pr.ciState) {
        case "FAILURE":
        case "ERROR":
          return "failure";
        case "PENDING":
        case "EXPECTED":
          hasPending = true;
          break;
        case "SUCCESS":
          break;
        default:
          hasPending = true;
          break;
      }
    }

    return hasPending ? "pending" : "success";
  }

  _updatePanelIcon(state) {
    if (!this._icon) return;
    this._icon.icon_name = ICON_MAP[state] ?? ICON_MAP.unknown;
    this._icon.style_class = STYLE_MAP[state] ?? STYLE_MAP.unknown;
  }

  _updateConversationIcon(prs) {
    if (!this._conversationIcon) return;
    this._conversationIcon.visible =
      prs && prs.some((pr) => pr.hasUnreadComments);
  }

  _buildMenu(prs, errorMessage) {
    const menu = this._indicator?.menu;
    if (!menu) return;

    menu.removeAll();

    if (errorMessage) {
      menu.addMenuItem(
        new PopupMenu.PopupMenuItem(errorMessage, { reactive: false }),
      );
    } else if (!prs || prs.length === 0) {
      menu.addMenuItem(
        new PopupMenu.PopupMenuItem("No open PRs", { reactive: false }),
      );
    } else {
      for (const pr of prs) {
        const icon = this._ciStateIcon(pr.ciState);
        const commentMarker = pr.hasUnreadComments ? "\u{1F4AC} " : "";
        const label = `${commentMarker}${pr.repo}#${pr.number}: ${pr.title}`;
        const item = new PopupMenu.PopupImageMenuItem(label, icon);

        const ornament = item._icon;
        if (ornament) {
          const cls = this._ciStateStyle(pr.ciState);
          if (cls) ornament.add_style_class_name(cls);
        }

        item.connect("activate", () => {
          Gio.AppInfo.launch_default_for_uri(pr.url, null);
        });
        menu.addMenuItem(item);
      }
    }

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const refreshItem = new PopupMenu.PopupMenuItem("Refresh");
    refreshItem.connect("activate", () => this._refresh());
    menu.addMenuItem(refreshItem);

    const settingsItem = new PopupMenu.PopupMenuItem("Settings");
    settingsItem.connect("activate", () => this.openPreferences());
    menu.addMenuItem(settingsItem);
  }

  _ciStateIcon(state) {
    switch (state) {
      case "SUCCESS":
        return "emblem-ok-symbolic";
      case "FAILURE":
      case "ERROR":
        return "dialog-error-symbolic";
      case "PENDING":
      case "EXPECTED":
        return "content-loading-symbolic";
      default:
        return "dialog-question-symbolic";
    }
  }

  _ciStateStyle(state) {
    switch (state) {
      case "SUCCESS":
        return "github-pr-success";
      case "FAILURE":
      case "ERROR":
        return "github-pr-failure";
      case "PENDING":
      case "EXPECTED":
        return "github-pr-pending";
      default:
        return null;
    }
  }
}
