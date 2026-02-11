import Gio from "gi://Gio";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class GitHubPRStatusPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: _("GitHub PR Status"),
      icon_name: "applications-internet-symbolic",
    });
    window.add(page);

    // Authentication
    const authGroup = new Adw.PreferencesGroup({
      title: _("Authentication"),
      description: _(
        'A GitHub Personal Access Token with "repo" scope is required to read PR and CI status.',
      ),
    });
    page.add(authGroup);

    const tokenRow = new Adw.PasswordEntryRow({
      title: _("GitHub Token"),
      show_apply_button: true,
    });
    settings.bind(
      "github-token",
      tokenRow,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    authGroup.add(tokenRow);

    // Polling
    const pollingGroup = new Adw.PreferencesGroup({
      title: _("Polling"),
    });
    page.add(pollingGroup);

    const intervalAdjustment = new Gtk.Adjustment({
      lower: 60,
      upper: 3600,
      step_increment: 30,
      page_increment: 60,
      value: settings.get_int("refresh-interval"),
    });

    const intervalRow = new Adw.SpinRow({
      title: _("Refresh Interval"),
      subtitle: _("Seconds between GitHub API polls"),
      adjustment: intervalAdjustment,
    });
    settings.bind(
      "refresh-interval",
      intervalAdjustment,
      "value",
      Gio.SettingsBindFlags.DEFAULT,
    );
    pollingGroup.add(intervalRow);

    // Notifications
    const notifyGroup = new Adw.PreferencesGroup({
      title: _("Notifications"),
    });
    page.add(notifyGroup);

    const notifyRow = new Adw.SwitchRow({
      title: _("Notify on Status Change"),
      subtitle: _("Show a desktop notification when a PR's CI status changes"),
    });
    settings.bind(
      "notify-on-change",
      notifyRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    notifyGroup.add(notifyRow);

    // prevent GC of settings while window is open
    window._settings = settings;
  }
}
