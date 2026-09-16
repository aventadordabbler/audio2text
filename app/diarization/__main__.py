import argparse
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys
import traceback
import resource


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--segmentation-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    output = sys.stdout
    def send(value):
        output.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        output.flush()
    # Libraries may print during import/inference; stdout is reserved for IPC.
    with redirect_stdout(sys.stderr):
        try:
            from .models import Models
            from .clustering import cluster_file
            models = Models(args.models, args.segmentation_dir, args.threads)
            send({"ready": True, "model_tag": models.tag})
        except Exception:
            traceback.print_exc()
            send({"ready": False})
            return
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request["type"] == "window":
                    result = models.window(request)
                elif request["type"] == "cluster":
                    result = cluster_file(request["path"])
                elif request["type"] == "stats":
                    usage = resource.getrusage(resource.RUSAGE_SELF)
                    result = {"peak_rss_mib": usage.ru_maxrss / 1024,
                              "cpu_seconds": usage.ru_utime + usage.ru_stime,
                              "model_tag": models.tag}
                elif request["type"] == "score":
                    from pyannote.database.util import load_rttm
                    from pyannote.core import Annotation, Segment
                    from pyannote.metrics.diarization import DiarizationErrorRate
                    references = load_rttm(request["reference"])
                    uri = request.get("uri") or next(iter(references))
                    if len(references) != 1 and not request.get("uri"):
                        raise ValueError("Specify the reference URI for a multi-recording RTTM")
                    hypothesis = Annotation(uri=uri)
                    with open(request["timeline"]) as source:
                        for number, line in enumerate(source):
                            turn = json.loads(line)
                            for speaker in turn["speaker_ids"]:
                                hypothesis[Segment(turn["start_ms"] / 1000, turn["end_ms"] / 1000),
                                           f"{number}-{speaker}"] = speaker
                    metric = DiarizationErrorRate(collar=0, skip_overlap=False)
                    result = metric(references[uri], hypothesis, detailed=True)
                else:
                    raise ValueError("Unknown operation")
                send({"result": result})
            except Exception:
                traceback.print_exc()
                send({"error": "inference_failed"})


if __name__ == "__main__":
    main()
