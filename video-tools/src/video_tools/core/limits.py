"""Supported values and limits shared by the core checks, GUI and MCP server."""

MAX_OUTPUT_IMAGES = 10000
MAX_OUTPUT_MEGAPIXELS = 64
MAX_OUTPUT_PIXELS = MAX_OUTPUT_MEGAPIXELS * 1024 * 1024
# Container durations round, so an end time this far past the probed length is still valid.
DURATION_TOLERANCE = 0.05

MAX_ACTIVE_JOBS = 2
MAX_PENDING_JOBS = 8
MAX_JOB_HISTORY = 100

ROTATIONS = (0, 90, 180, 270)
GRID_SIZES = (2, 3)
MIN_SPEED, MAX_SPEED = 0.25, 4
MAX_CRF = 51

IMAGE_FORMATS = ("png", "jpg")
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg")
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi")
