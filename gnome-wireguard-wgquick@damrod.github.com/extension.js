/* extension.js
 * Modified to use wg-quick up/down/show instead of NetworkManager
 */

const GETTEXT_DOMAIN = 'Wireguard-extension';

import GObject from 'gi://GObject'
import St from 'gi://St'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_CONFIG_DIRS = [
    `${GLib.get_user_config_dir()}/wireguard`
];

function spawn_async(cmdline) {
    try {
        GLib.spawn_command_line_async(cmdline);
    } catch (e) {
        logError(e);
    }
}

function run_sync(cmdline) {
    try {
        let [res, out, err, status] = GLib.spawn_command_line_sync(cmdline);
        if (res && out) {
            return (new TextDecoder()).decode(out);
        }
        return '';
    } catch (e) {
        logError(e);
        return '';
    }
}

function list_configs() {
    let configs = [];
    for (let dir of DEFAULT_CONFIG_DIRS) {
        try {
            let file = Gio.File.new_for_path(dir);
            if (!file.query_exists(null)) {
                continue;
            }
            let enumerator = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() === Gio.FileType.REGULAR) {
                    let name = info.get_name();
                    if (name.endsWith('.conf')) {
                        let path = dir + '/' + name;
                        configs.push({ id: name.replace(/\.conf$/, ''), path: path });
                    }
                }
            }
            enumerator.close(null);
        } catch (e) {
            // ignore
        }
    }
    // Remove duplicates by id, keep first occurrence (user dir first)
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

function active_interfaces() {
    // Use `wg show interfaces` if available, fallback to `ip -o link` filter
    let out = run_sync('bash -c "wg show interfaces 2>/dev/null"');
    if (out && out.trim().length > 0) {
        return out.trim().split(/\s+/);
    }
    // fallback
    out = run_sync(`bash -c "ip -o link show type wireguard 2>/dev/null | awk -F': ' '{print \$2}'"`);
    if (out && out.trim().length > 0) {
        return out.trim().split(/\n/).map(s => s.trim());
    }
    return [];
}

var WGConnection = class {
    constructor(id, path) {
        this.id = id;
        this.path = path;
    }
};

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(WGConfigs) {
            super._init(0.0, _('Wireguard-extension'));
            let extensionObject = Extension.lookupByUUID('gnome-wireguard-wgquick@damrod.github.com');
            this.settings = extensionObject.getSettings('org.gnome.shell.extensions.gnome-wireguard-wgquick@damrod.github.com');

            let icon = new St.Icon({ style_class: 'system-status-icon' });
            icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon-inactive.svg`);
            this.add_child(icon);

            this._configs = WGConfigs;
            this._icon = icon;
            this._create_switches(this.menu);

            // refresh periodically for external changes
            this._refresh_id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._refresh();
                return true;
            });

            let item2 = new PopupMenu.PopupMenuItem(_('Settings'));
            item2.connect('activate', () => { extensionObject.openPreferences(); });
            this.menu.addMenuItem(item2);
        }

        destroy() {
            if (this._refresh_id) {
                GLib.Source.remove(this._refresh_id);
                this._refresh_id = null;
            }
            super.destroy();
        }

        _refresh() {
            // rebuild list
            this.menu.removeAll();
            this._create_switches(this.menu);
            let extensionObject = Extension.lookupByUUID('gnome-wireguard-wgquick@damrod.github.com');
            let active = active_interfaces();
            if (active.length > 0) {
                this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon.svg`);
            } else {
                this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon-inactive.svg`);
            }
            // re-add settings item
            let item2 = new PopupMenu.PopupMenuItem(_('Settings'));
            item2.connect('activate', () => { extensionObject.openPreferences(); });
            this.menu.addMenuItem(item2);
        }

        _create_switches(menu) {
            let configs = list_configs();
            configs.forEach(cfg => {
                this._add_switch(menu, new WGConnection(cfg.id, cfg.path));
            });
            this._update_icon();
        }

        _add_switch(menu, connection) {
            let item = new PopupMenu.PopupSwitchMenuItem(_(connection.id), false);
            item.set_name(connection.id);
            item._connection = connection;
            let active = active_interfaces();
            item.setToggleState(active.includes(connection.id));
            item.connect('activate', () => {
                if (item._switch.state == true) {
                    // up
                    spawn_async(`sudo /usr/bin/wg-quick up "${connection.path}"`);
                    Main.notify(_('Wireguard ' + connection.id + ' activating'));
                } else {
                    // down
                    spawn_async(`sudo /usr/bin/wg-quick down "${connection.path}"`);
                    Main.notify(_('Wireguard ' + connection.id + ' deactivating'));
                }
                // optimistic toggle. refresh will correct state.
            });

            // submenu: show status
            let showItem = new PopupMenu.PopupMenuItem(_('Show status'));
            showItem.connect('activate', () => {
                let out = run_sync(`bash -c "sudo wg show ${connection.id} 2>/dev/null || echo 'No output'"`);
                Main.notify(_('Wireguard status') + ':\n' + out.substring(0, 512));
            });
            menu.addMenuItem(item, 0);
            menu.addMenuItem(showItem, 1);
        }

        _update_icon() {
            let extensionObject = Extension.lookupByUUID('gnome-wireguard-wgquick@damrod.github.com');
            let active = active_interfaces();
            if (active.length > 0) {
                this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon.svg`);
            } else {
                this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon-inactive.svg`);
            }
        }
    }
);

export default class WireguardExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init(meta) {
    return new WireguardExtension(meta.uuid);
}