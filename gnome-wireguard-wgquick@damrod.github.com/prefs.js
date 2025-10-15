'use strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const STORAGE_DIR = `${GLib.get_user_config_dir()}/wireguard`;

function ensure_storage_dir() {
    try {
        let file = Gio.File.new_for_path(STORAGE_DIR);
        if (!file.query_exists(null)) {
            GLib.mkdir_with_parents(STORAGE_DIR, 0o700);
        }
    } catch (e) {
        logError(e);
    }
}

function stored_configs() {
    ensure_storage_dir();
    let configs = [];
    try {
        let dir = Gio.File.new_for_path(STORAGE_DIR);
        let en = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.REGULAR) {
                let name = info.get_name();
                if (name.endsWith('.conf')) configs.push({ id: name.replace(/\.conf$/, ''), path: STORAGE_DIR + '/' + name });
            }
        }
        en.close(null);
    } catch (e) {}
    return configs;
}

function copy_to_storage(src) {
    ensure_storage_dir();
    try {
        let srcf = Gio.File.new_for_path(src);
        let basename = srcf.get_basename();
        let dest = Gio.File.new_for_path(STORAGE_DIR + '/' + basename);
        srcf.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
        return dest.get_path();
    } catch (e) {
        logError(e);
        return null;
    }
}

function delete_stored(path) {
    try {
        let f = Gio.File.new_for_path(path);
        if (f.query_exists(null)) f.delete(null);
    } catch (e) { logError(e); }
}

export default class WireguardPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const top_label = new Gtk.Label({ label: 'Stored Wireguard configs (copied to user data dir)', valign: Gtk.Align.CENTER });
        group.add(top_label);

        const rows_group = new Adw.PreferencesGroup();
        page.add(rows_group);

        const add_group = new Adw.PreferencesGroup();
        const add_label = new Gtk.Label({ label: 'Add a Wireguard .conf file', valign: Gtk.Align.CENTER });
        add_group.add(add_label);

        const button = new Gtk.Button({ label: 'Choose a Wireguard Configuration file-R4' });
        const settings = this.getSettings();

        button.connect('clicked', () => {
            try {
                GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: button clicked" >> /tmp/wg-prefs.log'`);
            } catch (e) {}

            try {
                const parentWindow = button.get_root();
                GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: got parentWindow=${parentWindow}" >> /tmp/wg-prefs.log'`);

                const fc = new Gtk.FileChooserNative({
                    title: 'Choose a Wireguard .conf file',
                    transient_for: parentWindow,
                    modal: true,
                    action: Gtk.FileChooserAction.OPEN,
                });

                const filter = new Gtk.FileFilter();
                filter.add_suffix('conf');
                fc.add_filter(filter);

                fc.connect('response', (dialog, response) => {
                    try {
                        GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: response signal fired, response=${response}" >> /tmp/wg-prefs.log'`);

                        if (response === Gtk.ResponseType.ACCEPT) {
                            const file = dialog.get_file();
                            GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: selected file=${file ? file.get_path() : "null"}" >> /tmp/wg-prefs.log'`);

                            if (file) {
                                try { copy_to_storage(file.get_path()); } catch (e) {
                                    GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: copy_to_storage failed: ${e}" >> /tmp/wg-prefs.log'`);
                                }

                                try {
                                    settings.set_uint('last-refresh', Math.floor(Date.now() / 1000));
                                    GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: wrote last-refresh" >> /tmp/wg-prefs.log'`);
                                } catch (e) {
                                    GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: settings write failed: ${e}" >> /tmp/wg-prefs.log'`);
                                }

                                try {
                                    let child = rows_group.get_first_child();
                                    while (child) {
                                        let next = child.get_next_sibling();    // grab next before removing
                                        try {
                                            rows_group.remove(child);
                                        } catch (e) {
                                            // fallback if remove isn't available on this widget
                                            const parent = child.get_parent();
                                            if (parent && parent.remove)
                                                parent.remove(child);
                                            else
                                                child.set_parent(null);
                                        }
                                        child = next;
                                    }
                                    this._create_rows(rows_group);
                                    GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: rebuilt rows_group" >> /tmp/wg-prefs.log'`);
                                } catch (e) {
                                    GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: _create_rows failed: ${e}" >> /tmp/wg-prefs.log'`);
                                }
                            }
                        }
                    } catch (e) {
                        GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: exception in response: ${e}" >> /tmp/wg-prefs.log'`);
                    } finally {
                        try { dialog.destroy(); } catch (e) {}
                    }
                });

                fc.show();
                GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: file chooser shown" >> /tmp/wg-prefs.log'`);
            } catch (e) {
                GLib.spawn_command_line_sync(`bash -lc 'echo "prefs: exception in clicked handler: ${e}" >> /tmp/wg-prefs.log'`);
            }
        });
        add_group.add(button);

        page.add(add_group);

        this._create_rows(rows_group);

        window.add(page);
    }
    _create_rows(group) {
        let configs = stored_configs();
        configs.forEach(c => {
            const row = new Adw.ActionRow({ title: c.id });
            let del_btn = new Gtk.Button({ label: 'Delete' });
            del_btn.connect('clicked', () => {
                const dialog = new Gtk.MessageDialog({ transient_for: null, modal: true, message_type: Gtk.MessageType.QUESTION, buttons: Gtk.ButtonsType.YES_NO, text: `Delete ${c.id}?` });
                dialog.connect('response', (d, resp) => {
                    if (resp === Gtk.ResponseType.YES) {
                        delete_stored(c.path);
                        group.remove(row);
                    }
                    d.destroy();
                });
                dialog.show();
            });
            row.add_suffix(del_btn);
            group.add(row);
        });
    }
}