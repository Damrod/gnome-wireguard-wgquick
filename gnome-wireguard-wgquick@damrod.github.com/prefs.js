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
    // dedupe by id, keep order
    let seen = new Set();
    let unique = [];
    for (let c of configs) {
        if (!seen.has(c.id)) {
            seen.add(c.id);
            unique.push(c);
        }
    }
    return unique;
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
        this._prefs_window = window; // used for transient dialogs
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const top_label = new Gtk.Label({ label: 'Stored Wireguard configs (copied to user data dir)', valign: Gtk.Align.CENTER });
        group.add(top_label);

        // make rows_group mutable so we can replace it cleanly
        let rows_group = new Adw.PreferencesGroup();
        page.add(rows_group);

        const add_group = new Adw.PreferencesGroup();
        const add_label = new Gtk.Label({ label: 'Add a Wireguard .conf file', valign: Gtk.Align.CENTER });
        add_group.add(add_label);

        const button = new Gtk.Button({ label: 'Choose a Wireguard Configuration file-R4' });
        const settings = this.getSettings();

        button.connect('clicked', () => {
            log('prefs: button clicked');

            try {
                const parentWindow = button.get_root();
                log(`prefs: got parentWindow=${parentWindow}`);

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
                        log(`prefs: response signal fired, response=${response}`);

                        if (response === Gtk.ResponseType.ACCEPT) {
                            const file = dialog.get_file();
                            log(`prefs: selected file=${file ? file.get_path() : "null"}`);

                            if (file) {
                                try {
                                    copy_to_storage(file.get_path());
                                } catch (e) {
                                    log(`prefs: copy_to_storage failed: ${e}`);
                                }

                                try {
                                    settings.set_uint('last-refresh', Math.floor(Date.now() / 1000));
                                    log('prefs: wrote last-refresh');
                                } catch (e) {
                                    log(`prefs: settings write failed: ${e}`);
                                }

                                try {
                                    // create a fresh group, populate it, then swap it in.
                                    const new_group = new Adw.PreferencesGroup();
                                    this._create_rows(new_group);

                                    // add new group to page then remove old one
                                    page.add(new_group);
                                    try { page.remove(rows_group); } catch (e) { log(`prefs: page.remove failed: ${e}`); }

                                    // update reference so further actions operate on new_group
                                    rows_group = new_group;
                                    log('prefs: replaced rows_group with new populated group');
                                } catch (e) {
                                    log(`prefs: _create_rows failed: ${e}`);
                                }
                            }
                        }
                    } catch (e) {
                        log(`prefs: exception in response: ${e}`);
                    } finally {
                        try { dialog.destroy(); } catch (e) {}
                    }
                });

                fc.show();
                log('prefs: file chooser shown');
            } catch (e) {
                log(`prefs: exception in clicked handler: ${e}`);
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
                const dialog = new Gtk.MessageDialog({
                    transient_for: this._prefs_window || null,
                    modal: true,
                    message_type: Gtk.MessageType.QUESTION,
                    buttons: Gtk.ButtonsType.YES_NO,
                    text: `Delete ${c.id}?`
                });
                dialog.connect('response', (d, resp) => {
                    if (resp === Gtk.ResponseType.YES) {
                        delete_stored(c.path);
                        try {
                            // safe removal: prefer actual parent.remove(row)
                            const parent = row.get_parent();
                            if (parent && parent.remove) parent.remove(row);
                            else if (group.remove) group.remove(row);
                            else row.set_parent(null);
                        } catch (e) {
                            log(`prefs: remove row after delete failed: ${e}`);
                        }
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
