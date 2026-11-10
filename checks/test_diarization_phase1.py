import asyncio
import json
from pathlib import Path

import numpy as np

from app.audio import SpeechSession, StreamOptions
from app.diarization.finalize import global_timeline, label_document
from app.diarization.models import Models
from app.diarization.service import DiarizationService
from app.diarization.state import SpeakerState, label_segment
from app.meetings import MeetingStore
from app.recordings import AudioArchive
from app.transcripts import plain_text


FIXTURE = Path(__file__).parent / "fixtures" / "voiceprint_diarization_phase1.json"


def fixture():
    return json.loads(FIXTURE.read_text())


def test_window_diagnostics_does_not_inherit_registered_identity_across_tracks(tmp_path):
    sample = fixture()["window_track_reorder"]
    voiceprint = sample["voiceprint"]
    state = SpeakerState(tmp_path, [{**voiceprint, "embedding": json.dumps(voiceprint["embedding"])}])

    for window in sample["windows"]:
        assert state.accept(window)

    entries = [json.loads(line) for line in state.log.read_text().splitlines()]
    assert len(entries) == len(sample["windows"])

    first = entries[0]["diagnostics"]
    assert first["window"]["fresh_from"] == 0
    assert first["summary"]["overlap_with_unresolved_track_count"] == 1
    assert {item["reason"] for item in first["matching"]} == {"confident_match", "no_embedding"}
    assert any(item["reason"] == "raw_overlap_with_unresolved_track" for item in first["turns"])

    second = entries[1]["diagnostics"]
    assert second["summary"]["anonymous_created_count"] == 1
    assert second["summary"]["inherited_match_count"] == 0
    assert second["summary"]["recovered_blocked_match_count"] == 0
    anonymous = next(item for item in second["matching"] if item["reason"] == "anonymous_created")
    assert anonymous["candidate_count"] == 0
    assert anonymous["blocked_candidate_id"] == "registered-speaker"
    assert anonymous["blocked_candidate_score"] == 1.0
    assert anonymous["speaker_id"] != "registered-speaker"
    assert state.value["speakers"][anonymous["speaker_id"]]["name"] == "说话人 1"
    assert any(item["reason"] == "confirmed_overlap" for item in second["turns"])
    assert entries[0]["turns"][1]["overlap"] is False
    assert entries[0]["turns"][1]["unknown"] is True
    assert entries[1]["turns"][0]["overlap"] is True


def test_label_segment_distinguishes_overlap_multiple_and_unknown():
    segment = {"start_ms": 0, "end_ms": 1000, "text": "sample"}

    overlap = label_segment(segment, [{
        "start_ms": 0, "end_ms": 1000, "speaker_ids": ["a", "b"],
        "local_ids": [0, 1], "unknown": False, "overlap": True,
    }], 1000)
    assert overlap["speaker_status"] == "overlap"

    partially_resolved = label_segment(segment, [{
        "start_ms": 0, "end_ms": 1000, "speaker_ids": ["a"],
        "local_ids": [0, 1], "unknown": True, "overlap": False,
    }], 1000)
    assert partially_resolved["speaker_status"] == "multiple"
    assert partially_resolved["speaker_ids"] == ["a"]

    unresolved = label_segment(segment, [{
        "start_ms": 0, "end_ms": 1000, "speaker_ids": [],
        "local_ids": [0], "unknown": True, "overlap": False,
    }], 1000)
    assert unresolved["speaker_status"] == "unknown"

    multiple = label_segment(segment, [
        {"start_ms": 0, "end_ms": 450, "speaker_ids": ["a"], "unknown": False, "overlap": False},
        {"start_ms": 450, "end_ms": 1000, "speaker_ids": ["b"], "unknown": False, "overlap": False},
    ], 1000)
    assert multiple["speaker_status"] == "multiple"

    repeated = label_segment(segment, [{
        "start_ms": 0, "end_ms": 1000, "speaker_ids": ["a"],
        "local_ids": [0, 1], "unknown": False, "overlap": False,
    }], 1000)
    assert repeated["speaker_status"] == "assigned"


def test_registered_match_requires_current_window_threshold(tmp_path):
    state = SpeakerState(tmp_path, [{
        "id": "registered-speaker", "name": "Registered speaker",
        "embedding": json.dumps([1.0, 0.0]),
    }])
    assert state.accept({
        "model_tag": "fixture", "start": 0, "end": 48000,
        "speakers": [{"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 2000}],
        "turns": [{"start_ms": 0, "end_ms": 1000, "local_ids": [0]}],
    })
    assert state.accept({
        "model_tag": "fixture", "start": 16000, "end": 64000,
        "speakers": [{"local_id": 0, "embedding": [0.58, 0.814], "clean_ms": 2000, "fresh_ms": 1000}],
        "turns": [{"start_ms": 500, "end_ms": 2200, "local_ids": [0]}],
    })
    entries = [json.loads(line) for line in state.log.read_text().splitlines()]
    match = entries[1]["diagnostics"]["matching"][0]
    assert match["top_score"] < .6
    assert match["reason"] == "anonymous_created"
    assert match["speaker_id"] != "registered-speaker"


def test_plain_text_keeps_resolved_name_when_another_track_is_unknown():
    document = {
        "speakers": {"speaker-a": {"name": "甲"}},
        "segments": [{
            "segment_id": 0, "start_ms": 0, "end_ms": 1000, "text": "内容",
            "speaker_ids": ["speaker-a"], "speaker_status": "multiple",
            "speaker_turns": [{"speaker_ids": ["speaker-a"], "unknown": True}],
        }],
    }
    assert plain_text(document, labels=True) == "[甲、说话人待确认] 内容"


def test_key_speaker_status_counts_multiple_speaker_segments():
    assert MeetingStore._key_speaker_status(
        [{"voiceprint_id": "speaker-a", "name": "甲"}],
        {"segments": [{"speaker_status": "multiple", "speaker_ids": ["speaker-a", "anonymous"]}]},
    ) == [{"voiceprint_id": "speaker-a", "name": "甲", "status": "detected"}]


def test_global_timeline_marks_only_distinct_identities_as_overlap(tmp_path):
    state = SpeakerState(tmp_path, [
        {"id": "speaker-a", "name": "Speaker A", "embedding": json.dumps([1.0, 0.0])},
        {"id": "speaker-b", "name": "Speaker B", "embedding": json.dumps([0.0, 1.0])},
    ])
    assert state.accept({
        "model_tag": "fixture", "start": 0, "end": 48000,
        "speakers": [
            {"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 2000},
            {"local_id": 1, "embedding": [0.0, 1.0], "clean_ms": 2000, "fresh_ms": 2000},
        ],
        "turns": [{"start_ms": 0, "end_ms": 1000, "local_ids": [0, 1]}],
    })

    global_timeline(tmp_path, [[1.0, 0.0], [0.0, 1.0]], state)
    timeline = [json.loads(line) for line in (tmp_path / "speaker-timeline.jsonl").read_text().splitlines()]
    assert timeline[0]["speaker_ids"] == ["speaker-a", "speaker-b"]
    assert timeline[0]["overlap"] is True


def test_label_document_inherits_identity_across_short_pause(tmp_path):
    turns = [
        {"start_ms": 0, "end_ms": 1000, "speaker_ids": ["speaker-a"], "unknown": False, "overlap": False},
        {"start_ms": 1600, "end_ms": 2200, "speaker_ids": [], "unknown": True, "overlap": False},
        {"start_ms": 2700, "end_ms": 3700, "speaker_ids": ["speaker-a"], "unknown": False, "overlap": False},
        {"start_ms": 4300, "end_ms": 4900, "speaker_ids": [], "unknown": True, "overlap": False},
    ]
    (tmp_path / "speaker-timeline.jsonl").write_text("\n".join(json.dumps(turn) for turn in turns) + "\n")
    document = {"segments": [
        {"segment_id": 0, "start_ms": 0, "end_ms": 1000, "text": "第一段"},
        {"segment_id": 1, "start_ms": 1600, "end_ms": 2200, "text": "停顿后的第二段"},
        {"segment_id": 2, "start_ms": 2700, "end_ms": 3700, "text": "第三段"},
        {"segment_id": 3, "start_ms": 4300, "end_ms": 4900, "text": "末尾短段"},
    ]}

    labeled = list(label_document(tmp_path, document, 5000))
    assert [segment["speaker_status"] for segment in labeled] == ["assigned"] * 4
    assert labeled[1]["speaker_ids"] == ["speaker-a"]
    assert all(not turn["unknown"] for turn in labeled[1]["speaker_turns"])
    assert labeled[3]["speaker_ids"] == ["speaker-a"]


def test_label_document_does_not_inherit_when_adjacent_tracks_conflict(tmp_path):
    turns = [
        {"start_ms": 0, "end_ms": 1000, "speaker_ids": ["speaker-a"], "unknown": False, "overlap": False},
        {"start_ms": 1600, "end_ms": 2200, "speaker_ids": [], "unknown": True, "overlap": False},
        {"start_ms": 2700, "end_ms": 3700, "speaker_ids": ["speaker-b"], "unknown": False, "overlap": False},
    ]
    (tmp_path / "speaker-timeline.jsonl").write_text("\n".join(json.dumps(turn) for turn in turns) + "\n")
    document = {"segments": [
        {"segment_id": 0, "start_ms": 0, "end_ms": 1000, "text": "第一段"},
        {"segment_id": 1, "start_ms": 1600, "end_ms": 2200, "text": "不确定段"},
        {"segment_id": 2, "start_ms": 2700, "end_ms": 3700, "text": "另一人"},
    ]}

    labeled = list(label_document(tmp_path, document, 4000))
    assert labeled[1]["speaker_status"] == "unknown"
    assert labeled[1]["speaker_ids"] == []


def test_global_timeline_rejects_registered_track_when_center_disagrees(tmp_path):
    state = SpeakerState(tmp_path, [
        {"id": "speaker-a", "name": "Speaker A", "embedding": json.dumps([1.0, 0.0])},
    ])
    for start, end, turn_start, turn_end in ((0, 48000, 0, 1200), (16000, 64000, 1000, 2200)):
        assert state.accept({
            "model_tag": "fixture", "start": start, "end": end,
            "speakers": [{"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 1000}],
            "turns": [{"start_ms": turn_start, "end_ms": turn_end, "local_ids": [0]}],
        })
    assert any(track["status"] == "stable" for track in state.value["tracks"].values())

    global_timeline(tmp_path, [[0.0, 1.0]], state)
    timeline = [json.loads(line) for line in (tmp_path / "speaker-timeline.jsonl").read_text().splitlines()]
    assert [turn["speaker_ids"] for turn in timeline] == [[], []]
    assert all(turn["unknown"] for turn in timeline)


def test_global_timeline_rejects_ambiguous_registered_center(tmp_path):
    state = SpeakerState(tmp_path, [
        {"id": "speaker-a", "name": "Speaker A", "embedding": json.dumps([1.0, 0.0])},
        {"id": "speaker-b", "name": "Speaker B", "embedding": json.dumps([0.95, 0.312249])},
    ])
    assert state.accept({
        "model_tag": "fixture", "start": 0, "end": 48000,
        "speakers": [{"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 2000}],
        "turns": [{"start_ms": 0, "end_ms": 1000, "local_ids": [0]}],
    })

    names = global_timeline(tmp_path, [[1.0, 0.0]], state)
    timeline = [json.loads(line) for line in (tmp_path / "speaker-timeline.jsonl").read_text().splitlines()]
    assert timeline[0]["speaker_ids"]
    assert timeline[0]["speaker_ids"] not in (["speaker-a"], ["speaker-b"])
    anonymous = [value for key, value in names.items() if key not in {"speaker-a", "speaker-b"}]
    assert anonymous == [{"name": "说话人 1"}]


def test_diarization_candidates_follow_meeting_scope():
    class Store:
        rows = [
            {"id": "speaker-a", "department_id": "department-a"},
            {"id": "speaker-b", "department_id": "department-b"},
            {"id": "speaker-c", "department_id": "department-a"},
        ]

        def list_voiceprints(self, user_id=None, department_id=None):
            if department_id is not None:
                return [row for row in self.rows if row["department_id"] == department_id]
            return list(self.rows)

    service = DiarizationService.__new__(DiarizationService)
    service.store = Store()
    assert [row["id"] for row in service._voiceprint_candidates({
        "key_speakers": [{"voiceprint_id": "speaker-b"}], "department_id": "department-a",
    })] == ["speaker-b"]
    assert [row["id"] for row in service._voiceprint_candidates({
        "key_speakers": [], "department_id": "department-a",
    })] == ["speaker-a", "speaker-c"]
    assert [row["id"] for row in service._voiceprint_candidates({
        "key_speakers": [], "department_id": "missing",
    })] == ["speaker-a", "speaker-b", "speaker-c"]


def test_embedding_preprocessing_keeps_only_clean_single_speaker_frames():
    models = Models.__new__(Models)

    def masks(_samples):
        return None, np.array([0.01, 0.03]), None, np.array([[True, False], [False, False]])

    models._masks = masks
    cleaned = models._clean_samples(np.ones(640, dtype=np.float32))
    assert len(cleaned) == 480


def test_embed_archive_reads_voiceprint_audio_longer_than_one_window(tmp_path):
    samples = np.zeros(160000 + 16000, dtype=np.float32)
    archive = AudioArchive(tmp_path)
    archive.begin()
    archive.append(samples)
    archive.end()

    models = Models.__new__(Models)
    models.embed = lambda audio: len(audio)
    assert models.embed_archive(tmp_path, len(samples)) == len(samples)


class SameTextEngine:
    def new_state(self, *_args):
        return object()

    async def feed(self, _audio, _state):
        return "same speaker"

    async def finish(self, _state):
        return "same speaker"


def test_endpoint_pause_fixture_keeps_two_asr_segments():
    sample = fixture()["endpoint_pause"]
    speech = np.full(round(sample["speech_seconds"] * sample["sample_rate"]), 0.2, dtype=np.float32)
    silence = np.zeros(round(sample["silence_ms"] * sample["sample_rate"] / 1000), dtype=np.float32)
    audio = np.concatenate((speech, silence, speech))
    session = SpeechSession(
        SameTextEngine(), "zh",
        options=StreamOptions(end_silence_ms=600),
    )

    async def run():
        events = await session.feed_samples(audio)
        events.extend(await session.flush())
        return events

    finals = [event for event in asyncio.run(run()) if event["type"] == "final"]
    assert len(finals) == sample["expected_final_segments"]
    assert finals[0]["end_ms"] < finals[1]["start_ms"] + 100


def test_track_reorder_preserves_two_registered_identities(tmp_path):
    voiceprints = [
        {"id": "speaker-a", "name": "Speaker A", "embedding": json.dumps([1.0, 0.0])},
        {"id": "speaker-b", "name": "Speaker B", "embedding": json.dumps([0.0, 1.0])},
    ]
    state = SpeakerState(tmp_path, voiceprints)
    first = {
        "model_tag": "fixture", "start": 0, "end": 160000,
        "speakers": [
            {"local_id": 0, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 2000},
            {"local_id": 1, "embedding": [0.0, 1.0], "clean_ms": 2000, "fresh_ms": 2000},
        ],
        "turns": [
            {"start_ms": 0, "end_ms": 1200, "local_ids": [0]},
            {"start_ms": 1200, "end_ms": 2400, "local_ids": [1]},
        ],
    }
    second = {
        "model_tag": "fixture", "start": 16000, "end": 176000,
        "speakers": [
            {"local_id": 0, "embedding": [0.0, 1.0], "clean_ms": 2000, "fresh_ms": 1000},
            {"local_id": 1, "embedding": [1.0, 0.0], "clean_ms": 2000, "fresh_ms": 1000},
        ],
        "turns": [
            {"start_ms": 1200, "end_ms": 2400, "local_ids": [0]},
            {"start_ms": 0, "end_ms": 1200, "local_ids": [1]},
        ],
    }

    assert state.accept(first)
    assert state.accept(second)
    entries = [json.loads(line) for line in state.log.read_text().splitlines()]
    second_evidence = {item["local_id"]: item["speaker_id"] for item in entries[1]["evidence"]}
    assert second_evidence == {0: "speaker-b", 1: "speaker-a"}
    assert entries[1]["diagnostics"]["summary"]["anonymous_created_count"] == 0
