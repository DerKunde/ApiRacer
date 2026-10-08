# ApiRacer

A multiplayer racing game in the browser: the laptop shows the track, and the players' phones act as steering wheels by tilting them. Control data travels over a **WebRTC DataChannel** directly (peer-to-peer) from each phone to the laptop.

## Web APIs used

- **WebRTC** (`RTCPeerConnection`, `RTCDataChannel`): P2P connection phone → laptop
- **DeviceOrientation Events**: the phone's tilt sensor as a steering wheel

## Getting started

Requirement: [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
npm run dev
```

1. On the PC, open `http://localhost:5173/host.html`. It shows a room code and a link containing the PC's LAN address.
2. Connect the phone to the **same Wi-Fi** and open the link (or open `http://<PC-IP>:5173/controller.html` and enter the code).
3. Once connected, the PC shows the connection path and ping for each phone. The "Hallo senden" button sends a message directly over the DataChannel.

On first start, Windows may ask whether Node.js is allowed on the network. Allow it for **private networks**, otherwise the phone cannot load the page.

`npm run dev:https` starts the same setup with a self-signed HTTPS certificate. This is required for the orientation sensor on iOS. The browser shows a certificate warning once.

### Project structure

```
server/server.ts           Signaling server (WebSocket): relays offer/answer/ICE
src/shared/protocol.ts     Message types shared by server, PC and phone
src/client/host.ts         PC page: accepts connections, measures ping
src/client/controller.ts   Phone page: creates the offer and DataChannel
src/client/rtc.ts          WebRTC helpers (config, applying signals, connection path)
src/client/orientation.ts  Orientation sensor (permission handling)
```

## Notes

- **Documentation used:** _TBD_
- **Required browsers/devices:** _TBD_
- **Use case idea:** _TBD_
- **Limitations:** _TBD_
