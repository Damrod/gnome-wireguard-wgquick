# gnome-wireguard-extension
Wireguard extension for the gnome-shell


In order for this to work, these lines need to be added to /etc/sudoers:
```
<intended_user> ALL=(ALL) NOPASSWD: /usr/bin/wg-quick up *, /usr/bin/wg-quick down *
<intended_user> ALL=(ALL) NOPASSWD: /usr/bin/wg show *
```