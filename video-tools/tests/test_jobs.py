import threading
import unittest

from video_tools.core.backend import OperationCancelled
from video_tools.core.jobs import JobManager


class JobManagerTest(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.addCleanup(self.release.set)

    def manager(self, **options):
        manager = JobManager(**options)
        self.addCleanup(manager.close)
        self.addCleanup(self.release.set)
        return manager

    def blocked(self, cancel, _progress):
        while not self.release.wait(.01):
            if cancel.is_set():
                raise OperationCancelled()
        return {}

    def finish(self, manager, job_id):
        manager._executor.submit(lambda: None).result(5)
        for _ in range(500):
            job = manager.get(job_id)
            if job["status"] in {"completed", "failed", "cancelled"}:
                return job
            threading.Event().wait(.01)
        self.fail(f"Job did not finish: {job}")

    def test_result_and_full_progress_on_completion(self):
        manager = self.manager(workers=1)
        job = self.finish(manager, manager.submit("kind", lambda _c, _p: {"value": 1})["job_id"])
        self.assertEqual((job["status"], job["result"], job["progress_percent"], job["kind"]),
                         ("completed", {"value": 1}, 100, "kind"))

    def test_failure_keeps_the_error(self):
        def fail(_cancel, _progress):
            raise ValueError("문제")
        manager = self.manager(workers=1)
        job = self.finish(manager, manager.submit("kind", fail)["job_id"])
        self.assertEqual((job["status"], job["error"]), ("failed", "문제"))

    def test_progress_never_goes_back_or_reaches_100_early(self):
        seen = []
        manager = self.manager(workers=1)

        def report(_cancel, progress):
            progress(50, 5)
            progress(20, 6)
            seen.append(manager.get(job_id)["progress_percent"])
            progress(150, 7)
            seen.append(manager.get(job_id)["progress_percent"])
            seen.append(manager.get(job_id)["output_frames"])
            return {}
        started = threading.Event()
        job_id = manager.submit("gate", lambda _c, _p: started.wait(5) and {})["job_id"]
        job_id = manager.submit("kind", report)["job_id"]
        started.set()
        self.finish(manager, job_id)
        self.assertEqual(seen, [50, 99, 7])

    def test_pending_limit_counts_only_unfinished_jobs(self):
        manager = self.manager(workers=1, max_pending=2)
        first = manager.submit("kind", self.blocked)["job_id"]
        second = manager.submit("kind", self.blocked)["job_id"]
        with self.assertRaises(ValueError):
            manager.submit("kind", self.blocked)
        self.release.set()
        self.finish(manager, first)
        self.finish(manager, second)
        manager.submit("kind", lambda _c, _p: {})

    def test_cancel_a_queued_job_never_runs_it(self):
        ran = []
        manager = self.manager(workers=1)
        first = manager.submit("kind", self.blocked)["job_id"]
        queued = manager.submit("kind", lambda _c, _p: ran.append(1) or {})["job_id"]
        answer = manager.cancel(queued)
        self.assertTrue(answer["accepted"])
        self.assertEqual(answer["status"], "cancelling")
        self.release.set()
        self.finish(manager, first)
        self.assertEqual(self.finish(manager, queued)["status"], "cancelled")
        self.assertEqual(ran, [])

    def test_cancel_a_running_job(self):
        started = threading.Event()

        def work(cancel, progress):
            started.set()
            return self.blocked(cancel, progress)
        manager = self.manager(workers=1)
        job_id = manager.submit("kind", work)["job_id"]
        self.assertTrue(started.wait(5))
        manager.cancel(job_id)
        self.assertEqual(self.finish(manager, job_id)["status"], "cancelled")

    def test_cancel_a_finished_job_is_refused(self):
        manager = self.manager(workers=1)
        job_id = manager.submit("kind", lambda _c, _p: {})["job_id"]
        self.finish(manager, job_id)
        answer = manager.cancel(job_id)
        self.assertFalse(answer["accepted"])
        self.assertEqual(answer["status"], "completed")

    def test_unknown_job(self):
        with self.assertRaises(ValueError):
            self.manager().get("없음")

    def test_history_drops_the_oldest_finished_job(self):
        manager = self.manager(workers=1, max_history=2)
        first = manager.submit("kind", lambda _c, _p: {})["job_id"]
        self.finish(manager, first)
        second = manager.submit("kind", lambda _c, _p: {})["job_id"]
        self.finish(manager, second)
        third = manager.submit("kind", lambda _c, _p: {})["job_id"]
        self.finish(manager, third)
        self.assertEqual({job["job_id"] for job in manager.list()}, {second, third})

    def test_results_are_copies(self):
        manager = self.manager(workers=1)
        job_id = manager.submit("kind", lambda _c, _p: {"files": ["a"]})["job_id"]
        self.finish(manager, job_id)
        manager.get(job_id)["result"]["files"].append("b")
        self.assertEqual(manager.get(job_id)["result"]["files"], ["a"])

    def test_close_cancels_unfinished_jobs_and_refuses_new_ones(self):
        started = threading.Event()

        def work(cancel, progress):
            started.set()
            return self.blocked(cancel, progress)
        manager = JobManager(workers=1)
        job_id = manager.submit("kind", work)["job_id"]
        self.assertTrue(started.wait(5))
        manager.close()
        self.assertEqual(manager.get(job_id)["status"], "cancelled")
        with self.assertRaises(RuntimeError):
            manager.submit("kind", lambda _c, _p: {})
