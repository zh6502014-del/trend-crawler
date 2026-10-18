"""Stage results retain diagnostics even when no safe output can be published."""


class StageFailure(RuntimeError):
    def __init__(self, message, stats=None):
        super().__init__(message)
        self.stats = stats or {}
