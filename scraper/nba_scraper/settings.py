BOT_NAME = "nba_scraper"

SPIDER_MODULES = ["nba_scraper.spiders"]
NEWSPIDER_MODULE = "nba_scraper.spiders"

# disabled because the NBA stats API would block us
ROBOTSTXT_OBEY = False

# one request at a time to be respectful to upstream APIs
CONCURRENT_REQUESTS = 1
DOWNLOAD_DELAY = 2

AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 2
AUTOTHROTTLE_MAX_DELAY = 10
AUTOTHROTTLE_TARGET_CONCURRENCY = 1.0

RETRY_TIMES = 3
RETRY_HTTP_CODES = [403, 429, 500, 502, 503, 504]

# realistic browser headers to avoid 403s from stats.nba.com
DEFAULT_REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
}

DOWNLOADER_MIDDLEWARES = {
    "nba_scraper.middlewares.RotateUserAgentMiddleware": 400,
}

ITEM_PIPELINES = {
    "nba_scraper.pipelines.PostgresPipeline": 300,
}

LOG_LEVEL = "INFO"

# required by Scrapy 2.7+
REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
FEED_EXPORT_ENCODING = "utf-8"
