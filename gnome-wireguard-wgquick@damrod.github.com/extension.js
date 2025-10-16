/* extension.js
 * Modified to use wg-quick up/down/show instead of NetworkManager
 */

const GETTEXT_DOMAIN = 'Wireguard-extension';

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_CONFIG_DIRS = [`${GLib.get_user_config_dir()}/wireguard`];

function spawn_async(cmdline) {
    try {
        log(`spawn async: ${cmdline}`);
        GLib.spawn_command_line_async(cmdline);
    } catch (e) {
        logError(e);
    }
}

function run_sync(cmdline) {
    try {
        let [res, out, err, status] = GLib.spawn_command_line_sync(cmdline);
        if (res && out) {
            return new TextDecoder().decode(out);
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
            if (!file.query_exists(null)) continue;
            let enumerator = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() === Gio.FileType.REGULAR) {
                    let name = info.get_name();
                    if (name.endsWith('.conf')) {
                        let path = dir + '/' + name;
                        configs.push({ id: name.replace(/\.conf$/, ''), path });
                    }
                }
            }
            enumerator.close(null);
        } catch (e) {}
    }
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
    let out = run_sync('bash -c "wg show interfaces 2>/dev/null"');
    if (out && out.trim().length > 0) return out.trim().split(/\s+/);
    out = run_sync(`bash -c "ip -o link show type wireguard 2>/dev/null | awk -F': ' '{print $2}'"`);
    if (out && out.trim().length > 0) return out.trim().split(/\n/).map(s => s.trim());
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

            this._configs = WGConfigs;
            this._icon = new St.Icon({ style_class: 'system-status-icon' });
            this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/wireguard-icon-inactive.svg`);
            this.add_child(this._icon);

            this._create_switches(this.menu);

            this._refresh_id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._refresh();
                return true;
            });

            let settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            settingsItem.connect('activate', () => extensionObject.openPreferences());
            this.menu.addMenuItem(settingsItem);
        }

        destroy() {
            if (this._refresh_id) {
                GLib.Source.remove(this._refresh_id);
                this._refresh_id = null;
            }
            super.destroy();
        }

        _refresh() {
            this.menu.removeAll();
            this._create_switches(this.menu);
            let extensionObject = Extension.lookupByUUID('gnome-wireguard-wgquick@damrod.github.com');
            let active = active_interfaces();
            this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/${active.length > 0 ? 'wireguard-icon.svg' : 'wireguard-icon-inactive.svg'}`);
            let settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            settingsItem.connect('activate', () => extensionObject.openPreferences());
            this.menu.addMenuItem(settingsItem);
        }

        _create_switches(menu) {
            this._switches = new Map(); // id -> PopupSwitchMenuItem

            // ----- status section at top (non-interactive) -----
            let statusSection = new PopupMenu.PopupMenuSection();
            let active = active_interfaces();
            if (active.length > 0) {
                let id = active[0];
                let out = run_sync(`bash -c "sudo wg show ${id} 2>/dev/null || echo ''"`);
                if (out && out.trim().length > 0) {
                    let lines = this._parse_wg_for_status(out);
                    lines.forEach(line => {
                        let mi = new PopupMenu.PopupMenuItem(line, { reactive: false, can_focus: false });
                        mi.sensitive = false;
                        statusSection.addMenuItem(mi);
                    });
                } else {
                    let mi = new PopupMenu.PopupMenuItem(_('No Wireguard status available'), { reactive: false, can_focus: false });
                    mi.sensitive = false;
                    statusSection.addMenuItem(mi);
                }
            } else {
                let mi = new PopupMenu.PopupMenuItem(_('No Wireguard tunnel active'), { reactive: false, can_focus: false });
                mi.sensitive = false;
                statusSection.addMenuItem(mi);
            }
            menu.addMenuItem(statusSection);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            // ----------------------------------------------------

            let configs = list_configs();
            configs.forEach(cfg => {
                this._add_switch(menu, new WGConnection(cfg.id, cfg.path));
            });

            // removed old Show status menu item (status now shown in section above)

            this._update_icon();
        }

        _add_switch(menu, connection) {
            let item = new PopupMenu.PopupSwitchMenuItem(_(connection.id), false);
            item.set_name(connection.id);
            item._connection = connection;

            // record for later use instead of scanning menu
            this._switches.set(connection.id, item);

            let active = active_interfaces();
            item.setToggleState(active.includes(connection.id));

            item.connect('toggled', (item, state) => {
                if (state === true) {
                    // compute currently active interfaces except the one we are enabling
                    let actives = active_interfaces().filter(id => id !== connection.id);

                    // build down commands using stored items' connection.path
                    let downs = [];
                    for (let [id, mi] of this._switches) {
                        if (id !== connection.id && actives.includes(id)) {
                            // down by config path
                            downs.push(`sudo /usr/bin/wg-quick down "${mi._connection.path}"`);
                            try {
                                mi.setToggleState(false);
                            } catch (e) {
                                logError(e);
                            }
                        }
                    }

                    // prevent extra clicks while transition starts
                    try {
                        item.setSensitive(false);
                    } catch (e) { /* ignore */
                    }

                    // run downs serially and then up. use ';' so a failing down doesn't block the up.
                    let cmd;
                    if (downs.length > 0) {
                        cmd = `bash -c '${downs.join(' ; ')} ; sleep 0.1 ; sudo /usr/bin/wg-quick up "${connection.path}"'`;
                    } else {
                        cmd = `sudo /usr/bin/wg-quick up "${connection.path}"`;
                    }
                    spawn_async(cmd);

                    // re-enable the switch shortly after starting the operation
                    try {
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                            try {
                                item.setSensitive(true);
                            } catch (e) { /* ignore */
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                    } catch (e) { /* ignore */
                    }

                    // schedule a quick menu refresh so the status section updates after the operation starts
                    try {
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                            try { this._refresh(); } catch (e) { logError(e); }
                            return GLib.SOURCE_REMOVE;
                        });
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                            try { this._refresh(); } catch (e) { logError(e); }
                            return GLib.SOURCE_REMOVE;
                        });
                    } catch (e) { /* ignore */ }
                } else {
                    spawn_async(`sudo /usr/bin/wg-quick down "${connection.path}"`);
                    item.setToggleState(false);

                    // refresh status after turning down
                    try {
                        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                            try { this._refresh(); } catch (e) { logError(e); }
                            return GLib.SOURCE_REMOVE;
                        });
                    } catch (e) { /* ignore */ }
                }
            });

            menu.addMenuItem(item);
        }

        _update_icon() {
            let extensionObject = Extension.lookupByUUID('gnome-wireguard-wgquick@damrod.github.com');
            let active = active_interfaces();
            this._icon.gicon = Gio.icon_new_for_string(`${extensionObject.path}/icons/${active.length > 0 ? 'wireguard-icon.svg' : 'wireguard-icon-inactive.svg'}`);
        }

        // parse wg show output and return array of short lines to display
        _parse_wg_for_status(out) {
            // interface
            let iface = (out.match(/^interface:\s*(.+)$/m) || [])[1] || '';
            // transfer line e.g. "transfer: 527.49 KiB received, 863.55 KiB sent"
            let transferLine = (out.match(/transfer:\s*([^\n\r]+)/i) || [])[1] || '';
            let received = '', sent = '';
            let m = transferLine.match(/([\d.,]+\s+\w+)\s+received,\s*([\d.,]+\s+\w+)\s+sent/i);
            if (m) { received = m[1]; sent = m[2]; }
            // latest handshake
            let handshake = (out.match(/latest handshake:\s*(.+)$/m) || [])[1] || '';

            let lines = [];
            if (iface) lines.push(`interface: ${iface}`);
            if (received) lines.push(`received: ${received}`);
            if (sent) lines.push(`sent: ${sent}`);
            if (handshake) lines.push(`latest handshake: ${handshake}`);
            return lines;
        }
    });

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