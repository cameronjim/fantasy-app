import logging
from fake_useragent import UserAgent

logger = logging.getLogger(__name__)


class RotateUserAgentMiddleware:
    """Rotates the User-Agent header on every request using fake_useragent."""

    def __init__(self):
        try:
            self.ua = UserAgent(fallback=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ))
        except Exception:
            self.ua = None
            logger.warning(
                "fake_useragent failed to initialize; using default User-Agent"
            )

    @classmethod
    def from_crawler(cls, crawler):
        return cls()

    def process_request(self, request, spider):
        if self.ua:
            ua_string = self.ua.random
        else:
            ua_string = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        request.headers["User-Agent"] = ua_string
        return None
