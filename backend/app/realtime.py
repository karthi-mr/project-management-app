"""Live connection: pushes chat messages, typing, presence and notification pings over a WebSocket.

Works with a single application process (how the Docker image runs). Sync request handlers
hand events to the event loop with hub.push().
"""
import asyncio
import json

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.connections: dict[int, set[WebSocket]] = {}
        self.orgs: dict[int, int | None] = {}  # user id -> workspace id, for everyone connected

    def online(self, org_id: int | None) -> list[int]:
        """Who is connected in one workspace. Presence never crosses workspaces."""
        return sorted(u for u in self.connections if self.orgs.get(u) == org_id)

    async def _announce(self, org_id: int | None) -> None:
        members = self.online(org_id)
        await self.send(members, {"type": "presence", "online": members})

    async def connect(self, user_id: int, org_id: int | None, ws: WebSocket) -> None:
        first = user_id not in self.connections
        self.connections.setdefault(user_id, set()).add(ws)
        self.orgs[user_id] = org_id
        if first:
            await self._announce(org_id)

    async def disconnect(self, user_id: int, ws: WebSocket) -> None:
        sockets = self.connections.get(user_id)
        if not sockets:
            return
        sockets.discard(ws)
        if not sockets:
            del self.connections[user_id]
            org_id = self.orgs.pop(user_id, None)
            await self._announce(org_id)

    async def send(self, user_ids, payload: dict) -> None:
        text = json.dumps(payload)
        for user_id in set(user_ids):
            for ws in list(self.connections.get(user_id, ())):
                try:
                    await ws.send_text(text)
                except Exception:  # a dead socket is cleaned up by its own receive loop
                    pass

    def push(self, user_ids, payload: dict) -> None:
        """Thread-safe: schedule a send from a sync request handler."""
        ids = [u for u in user_ids if u is not None]
        if self.loop is None or not ids or not any(u in self.connections for u in ids):
            return
        asyncio.run_coroutine_threadsafe(self.send(ids, payload), self.loop)


hub = Hub()
