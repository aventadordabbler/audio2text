"""Bounded live subscriptions. Durable transcript revisions repair missed events."""
import asyncio


class MeetingEvents:
    def __init__(self):
        self.listeners = {}

    def subscribe(self, meeting_id, token):
        queue = asyncio.Queue(maxsize=128)
        self.listeners.setdefault(meeting_id, {})[token] = queue
        return queue

    def unsubscribe(self, meeting_id, token):
        listeners = self.listeners.get(meeting_id, {})
        listeners.pop(token, None)
        if not listeners:
            self.listeners.pop(meeting_id, None)

    def publish(self, meeting_id, event, exclude=None):
        for token, queue in tuple(self.listeners.get(meeting_id, {}).items()):
            if token == exclude:
                continue
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync"})
            else:
                queue.put_nowait(event)
