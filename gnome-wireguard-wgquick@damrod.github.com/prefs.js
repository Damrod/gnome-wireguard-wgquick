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

        const button = new Gtk.Button({ label: 'Choose a Wireguard Configuration file' });
        button.connect('clicked', () => {
            let select_win = new Gtk.FileChooserDialog({ use_header_bar: 1, title: 'Choose a Wireguard .conf file', action: Gtk.FileChooserAction.OPEN, modal: true });
            let filter = new Gtk.FileFilter();
            filter.add_suffix('conf');
            select_win.add_filter(filter);
            select_win.add_button('Add', -5).connect('clicked', () => {
                let f = select_win.get_file();
                if (f) {
                    copy_to_storage(f.get_path());
                    // rebuild list
                    while (rows_group.get_n_children() > 0) rows_group.remove(rows_group.get_first_child());
                    this._create_rows(rows_group);
                }
                select_win.destroy();
            });
            select_win.add_button('Cancel', -6).connect('clicked', () => select_win.destroy());
            select_win.present();
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