import Clutter from "gi://Clutter";
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
            nodes { ...PullRequestFields }
        }
    }
    requested: search(
        query: "is:open is:pr review-requested:@me archived:false",
        type: ISSUE,
        first: 50
    ) {
        nodes { ... on PullRequest { ...PullRequestFields } }
    }
    reviewed: search(
        query: "is:open is:pr reviewed-by:@me archived:false",
        type: ISSUE,
        first: 50
    ) {
        nodes { ... on PullRequest { ...PullRequestFields } }
    }
}

fragment PullRequestFields on PullRequest {
    title
    url
    number
    author { login }
    repository { nameWithOwner }
    commits(last: 1) {
        nodes {
            commit {
                oid
                statusCheckRollup {
                    state
                    contexts(last: 50) {
                        nodes {
                            ... on CheckRun { completedAt }
                            ... on StatusContext { createdAt }
                        }
                    }
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
    reviewRequests(first: 20) {
        nodes {
            requestedReviewer {
                ... on User { login }
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
    this._acceptedMap = this._loadAcceptedMap();
    this._lastSections = null;

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
    this._acceptedMap = null;
    this._lastSections = null;
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
      const sections = await this._fetchPRStatus(token);
      if (!this._indicator) return; // disabled while fetching
      const all = [...sections.mine, ...sections.reviewRequested];
      const prunedMap = this._pruneAcceptedMap(this._acceptedMap, all);
      if (prunedMap !== this._acceptedMap) {
        this._acceptedMap = prunedMap;
        this._saveAcceptedMap(this._acceptedMap);
      }
      this._applyAcceptedState(all);
      this._lastSections = sections;
      this._notifyChanges(all);
      const overallState = this._getOverallState(all);
      this._updatePanelIcon(overallState);
      this._updateConversationIcon(all);
      this._buildMenu(sections, null);
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

  _computeCommentSignals(pr, myLogin) {
    const myReviewDates = (pr.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING" && r.author?.login === myLogin)
      .map((r) => new Date(r.createdAt).getTime());
    const myCommentDates = (pr.comments?.nodes ?? [])
      .filter((c) => c.author?.login === myLogin)
      .map((c) => new Date(c.createdAt).getTime());
    const myReadThreshold = Math.max(0, ...myReviewDates, ...myCommentDates);

    const otherReviewDates = (pr.reviews?.nodes ?? [])
      .filter((r) => r.state !== "PENDING" && r.author?.login !== myLogin)
      .map((r) => new Date(r.createdAt).getTime());
    const otherCommentDates = (pr.comments?.nodes ?? [])
      .filter((c) => c.author?.login !== myLogin)
      .map((c) => new Date(c.createdAt).getTime());

    return {
      myReadThreshold,
      otherActivityDates: [...otherReviewDates, ...otherCommentDates],
    };
  }

  _applyAcceptedState(prs) {
    for (const pr of prs) {
      const entry = this._acceptedMap?.[pr.url];
      pr.accepted = entry ? { at: entry.at, headOid: entry.headOid } : null;
      const threshold = Math.max(
        pr.myReadThreshold,
        pr.accepted?.at ?? 0,
      );
      pr.hasUnreadComments = pr.otherActivityDates.some((d) => d > threshold);
    }
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

    const normalize = (pr, kind) => {
      const commit = pr.commits.nodes[0]?.commit;
      const rollup = commit?.statusCheckRollup;
      const contextDates = (rollup?.contexts?.nodes ?? [])
        .map((c) => c?.completedAt || c?.createdAt)
        .filter(Boolean)
        .map((d) => new Date(d).getTime());
      const latestCheckAt = contextDates.length
        ? Math.max(...contextDates)
        : null;
      const { myReadThreshold, otherActivityDates } =
        this._computeCommentSignals(pr, myLogin);
      return {
        kind,
        title: pr.title,
        url: pr.url,
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        author: pr.author?.login ?? "",
        ciState: rollup?.state ?? "UNKNOWN",
        headOid: commit?.oid ?? "",
        latestCheckAt,
        myReadThreshold,
        otherActivityDates,
        // Filled in by _applyAcceptedState before render.
        accepted: null,
        hasUnreadComments: false,
      };
    };

    const directlyRequested = (pr) =>
      (pr.reviewRequests?.nodes ?? []).some(
        (req) => req.requestedReviewer?.login === myLogin,
      );

    const mine = data.data.viewer.pullRequests.nodes.map((pr) =>
      normalize(pr, "mine"),
    );
    const mineUrls = new Set(mine.map((pr) => pr.url));

    // Keep a PR in the review list if I'm directly requested (not team-only)
    // or if I've already submitted a review (it stays after the request clears).
    const requestedNodes = (data.data.requested.nodes ?? []).filter(
      (pr) => pr && pr.url && directlyRequested(pr),
    );
    const reviewedNodes = (data.data.reviewed.nodes ?? []).filter(
      (pr) => pr && pr.url,
    );

    const seen = new Set(mineUrls);
    const reviewRequested = [];
    for (const pr of [...requestedNodes, ...reviewedNodes]) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      reviewRequested.push(normalize(pr, "review-requested"));
    }

    return { mine, reviewRequested };
  }

  _getOverallState(prs) {
    if (!prs || prs.length === 0) return "success";

    let hasPending = false;

    for (const pr of prs) {
      if (pr.accepted) continue;
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

  _buildMenu(sections, errorMessage) {
    const menu = this._indicator?.menu;
    if (!menu) return;

    menu.removeAll();

    if (errorMessage) {
      menu.addMenuItem(
        new PopupMenu.PopupMenuItem(errorMessage, { reactive: false }),
      );
    } else {
      const mine = sections?.mine ?? [];
      const reviewRequested = sections?.reviewRequested ?? [];

      if (mine.length === 0 && reviewRequested.length === 0) {
        menu.addMenuItem(
          new PopupMenu.PopupMenuItem("No open PRs", { reactive: false }),
        );
      } else {
        if (mine.length > 0) {
          menu.addMenuItem(this._buildSectionHeader("My PRs"));
          for (const pr of mine) menu.addMenuItem(this._buildPrMenuItem(pr));
        }
        if (reviewRequested.length > 0) {
          if (mine.length > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
          menu.addMenuItem(this._buildSectionHeader("Reviews Requested"));
          for (const pr of reviewRequested)
            menu.addMenuItem(this._buildPrMenuItem(pr));
        }
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

  _buildSectionHeader(text) {
    const header = new PopupMenu.PopupMenuItem(text, { reactive: false });
    header.label.add_style_class_name("github-pr-section-header");
    return header;
  }

  _buildPrMenuItem(pr) {
    const item = new PopupMenu.PopupBaseMenuItem({
      reactive: false,
      activate: false,
      can_focus: false,
    });

    // Slot 1: CI status icon (always present).
    const ciIcon = new St.Icon({
      icon_name: this._ciStateIcon(pr.ciState),
      style_class: "popup-menu-icon",
    });
    const ciCls = this._ciStateStyle(pr.ciState);
    if (ciCls) ciIcon.add_style_class_name(ciCls);
    item.add_child(this._buildStatusSlot(ciIcon));

    // Slot 2: unread-conversation icon (when applicable).
    const convIcon = pr.hasUnreadComments
      ? new St.Icon({
          icon_name: "user-available-symbolic",
          style_class: "popup-menu-icon github-pr-conversation",
        })
      : null;
    item.add_child(this._buildStatusSlot(convIcon));

    // Button 1: accept / reset acceptance (mode-swap in place).
    const isAccepted = !!pr.accepted;
    const acceptBtn = new St.Button({
      style_class: "github-pr-row-button",
      can_focus: true,
      track_hover: true,
      accessible_name: isAccepted
        ? "Reset acceptance"
        : "Accept current status",
    });
    acceptBtn.set_child(
      new St.Icon({
        icon_name: isAccepted ? "edit-undo-symbolic" : "emblem-ok-symbolic",
        style_class: "popup-menu-icon",
      }),
    );
    acceptBtn.connect("clicked", () => {
      this._indicator?.menu.close();
      if (isAccepted) this._resetAcceptance(pr);
      else this._acceptPr(pr);
    });
    item.add_child(acceptBtn);

    // Button 2: title, expands to fill the row, opens the PR.
    const labelText =
      pr.kind === "review-requested"
        ? `${pr.repo}#${pr.number} (by ${pr.author}): ${pr.title}`
        : `${pr.repo}#${pr.number}: ${pr.title}`;
    const titleLabel = new St.Label({
      text: labelText,
      x_expand: true,
      x_align: Clutter.ActorAlign.START,
      y_align: Clutter.ActorAlign.CENTER,
    });
    const titleBtn = new St.Button({
      style_class: "github-pr-row-title",
      can_focus: true,
      track_hover: true,
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      child: titleLabel,
    });
    titleBtn.connect("clicked", () => {
      this._indicator?.menu.close();
      Gio.AppInfo.launch_default_for_uri(pr.url, null);
    });
    item.add_child(titleBtn);

    return item;
  }

  _buildStatusSlot(iconOrNull) {
    const slot = new St.Bin({ style_class: "github-pr-status-slot" });
    if (iconOrNull) slot.set_child(iconOrNull);
    return slot;
  }

  _loadAcceptedMap() {
    try {
      const raw = this._settings.get_string("accepted-prs") || "{}";
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch (_) {
      // Corrupt JSON — start fresh.
    }
    return {};
  }

  _saveAcceptedMap(map) {
    try {
      this._settings.set_string("accepted-prs", JSON.stringify(map));
    } catch (e) {
      console.error(
        `[GitHub PR Status] Failed to save acceptance map: ${e.message}`,
      );
    }
  }

  _pruneAcceptedMap(map, allPrs) {
    if (!map) return {};
    const byUrl = new Map(allPrs.map((pr) => [pr.url, pr]));
    const next = {};
    let changed = false;
    for (const [url, entry] of Object.entries(map)) {
      const pr = byUrl.get(url);
      if (!pr) {
        changed = true;
        continue;
      }
      if (pr.headOid && entry.headOid !== pr.headOid) {
        changed = true;
        continue;
      }
      const isFailing = pr.ciState === "FAILURE" || pr.ciState === "ERROR";
      if (
        isFailing &&
        pr.latestCheckAt != null &&
        pr.latestCheckAt > entry.at
      ) {
        changed = true;
        continue;
      }
      next[url] = entry;
    }
    return changed ? next : map;
  }

  _acceptPr(pr) {
    this._acceptedMap = {
      ...(this._acceptedMap ?? {}),
      [pr.url]: { at: Date.now(), headOid: pr.headOid },
    };
    this._saveAcceptedMap(this._acceptedMap);
    this._refreshDerivedAndRender();
  }

  _resetAcceptance(pr) {
    if (!this._acceptedMap?.[pr.url]) return;
    const next = { ...this._acceptedMap };
    delete next[pr.url];
    this._acceptedMap = next;
    this._saveAcceptedMap(this._acceptedMap);
    this._refreshDerivedAndRender();
  }

  _refreshDerivedAndRender() {
    if (!this._lastSections || !this._indicator) return;
    const all = [
      ...this._lastSections.mine,
      ...this._lastSections.reviewRequested,
    ];
    this._applyAcceptedState(all);
    this._updatePanelIcon(this._getOverallState(all));
    this._updateConversationIcon(all);
    this._buildMenu(this._lastSections, null);
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
