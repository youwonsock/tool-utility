import asyncio
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

from media_test_support import make_video, test_ffmpeg

HAS_MCP = importlib.util.find_spec("mcp") is not None and importlib.util.find_spec("PIL") is not None


@unittest.skipUnless(HAS_MCP, "Install requirements-mcp.txt for MCP protocol tests")
class MCPProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_agent_workflow_and_workspace_boundaries(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from video_to_image_mcp import Workspace
        from configure_mcp import configuration

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ffmpeg = test_ffmpeg()
            await asyncio.to_thread(make_video, root / "input.mp4", ffmpeg)
            scope = Workspace(root)
            with self.assertRaises(ValueError):
                scope.resolve("../outside.mp4")
            outside = root.parent / "not-in-workspace.png"
            link = root / "outside.png"
            try:
                link.symlink_to(outside)
            except OSError:
                pass
            else:
                with self.assertRaises(ValueError):
                    scope.resolve("outside.png")
                link.unlink()

            config = configuration(root)["mcpServers"]["video-tools"]
            self.assertEqual(config["command"], str(Path(sys.executable).absolute()))
            portable = os.environ.get('VIDEO_TOOLS_TEST_MCP')
            environment = {**os.environ, "PYTHONUNBUFFERED": "1"}
            if portable:
                environment.update(PATH=os.environ.get('VIDEO_TOOLS_ISOLATED_PATH', '/usr/bin:/bin:/usr/sbin:/sbin'),
                                   PYTHONPATH='', PYTHONHOME='')
            parameters = StdioServerParameters(command=portable or config["command"],
                args=["--workspace", str(root)] if portable else config["args"] + ["--ffmpeg", ffmpeg],
                env=environment)
            async with stdio_client(parameters) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    expected = {"server_info", "list_media", "inspect_video", "start_frame_extraction",
                                "start_video_edit", "get_job", "list_jobs", "cancel_job", "read_image"}
                    self.assertEqual({tool.name for tool in tools.tools}, expected)

                    async def call(name, arguments=None):
                        result = await session.call_tool(name, arguments or {})
                        self.assertFalse(result.isError, result.content)
                        return result.structuredContent

                    async def finish(job):
                        for _ in range(100):
                            state = await call("get_job", {"job_id": job["job_id"]})
                            if state["status"] in {"completed", "failed", "cancelled"}:
                                self.assertEqual(state["status"], "completed", state)
                                return state["result"]
                            await asyncio.sleep(0.05)
                        self.fail("MCP job did not finish")

                    info = await call("inspect_video", {"video_path": "input.mp4"})
                    self.assertEqual((info["width"], info["height"], info["has_audio"]), (64, 36, True))
                    listing = await call("list_media")
                    self.assertIn("input.mp4", [entry["path"] for entry in listing["entries"]])
                    denied = await session.call_tool("inspect_video", {"video_path": "../outside.mp4"})
                    self.assertTrue(denied.isError)
                    invalid = await session.call_tool("start_frame_extraction",
                        {"video_path": "input.mp4", "output_directory": "bad", "grid_size": 8})
                    self.assertTrue(invalid.isError)

                    job = await call("start_frame_extraction", {"video_path": "input.mp4",
                        "output_directory": "captures", "end": 1, "grid_size": 2, "prefix": "scene[1]%"})
                    result = await finish(job)
                    self.assertEqual(result["saved_count"], 1)
                    preview = await session.call_tool("read_image", {"image_path": result["files"][0]})
                    self.assertFalse(preview.isError)
                    self.assertTrue(any(item.type == "image" for item in preview.content))

                    repeated = await finish(await call("start_frame_extraction", {"video_path": "input.mp4",
                        "output_directory": "captures", "end": 1, "grid_size": 2, "prefix": "scene[1]%"}))
                    self.assertEqual((repeated["saved_count"], repeated["skipped_count"]), (0, 1))

                    edited = await finish(await call("start_video_edit", {"video_path": "input.mp4",
                        "output_path": "edited/result.mp4", "start": 1, "end": 3, "speed": 2,
                        "rotation": 90, "width": 128, "height": 72, "mute": True}))
                    self.assertEqual((edited["width"], edited["height"], edited["has_audio"]), (128, 72, False))
                    finished_cancel = await call("cancel_job", {"job_id": job["job_id"]})
                    self.assertFalse(finished_cancel["accepted"])
                    self.assertEqual(len((await call("list_jobs"))["jobs"]), 3)
                    long_job = await call('start_frame_extraction', {'video_path': 'input.mp4',
                        'output_directory': 'cancel-output', 'interval': 0.005, 'width': 1280, 'height': 720})
                    cancelled = await call('cancel_job', {'job_id': long_job['job_id']})
                    self.assertTrue(cancelled['accepted'])
                    for _ in range(100):
                        state = await call('get_job', {'job_id': long_job['job_id']})
                        if state['status'] in {'cancelled', 'failed', 'completed'}: break
                        await asyncio.sleep(.05)
                    self.assertEqual(state['status'], 'cancelled', state)
                    self.assertFalse(list((root / 'cancel-output').glob('frame_*.png')))

