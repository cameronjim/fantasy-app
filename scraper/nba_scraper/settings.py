BOT_NAME = "nba_scraper"

SPIDER_MODULES = ["nba_scraper.spiders"]
NEWSPIDER_MODULE = "nba_scraper.spiders"

# Obey robots.txt -- disabled because the NBA stats API would block us
ROBOTSTXT_OBEY = False

# Be respectful: one request at a time with a 2-second delay
CONCURRENT_REQUESTS = 1
DOWNLOAD_DELAY = 2

# AutoThrottle
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 2
AUTOTHROTTLE_MAX_DELAY = 10
AUTOTHROTTLE_TARGET_CONCURRENCY = 1.0

# Retry settings
RETRY_TIMES = 3
RETRY_HTTP_CODES = [403, 429, 500, 502, 503, 504]

# Default request headers -- realistic browser to avoid 403s
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

# Downloader middlewares
DOWNLOADER_MIDDLEWARES = {
    "nba_scraper.middlewares.RotateUserAgentMiddleware": 400,
}

# Item pipelines
ITEM_PIPELINES = {
    "nba_scraper.pipelines.PostgresPipeline": 300,
}

# Logging
LOG_LEVEL = "INFO"

# Request fingerprinter (Scrapy 2.7+ requirement)
REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
FEED_EXPORT_ENCODING = "utf-8"
