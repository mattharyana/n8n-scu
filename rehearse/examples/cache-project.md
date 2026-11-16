# Example only — replace with your actual experience

Topic ID: cache-project
Topic title: Caching service redesign
Category: resume_bullet

I worked on an API caching redesign. The previous service queried PostgreSQL on every request. I implemented a cache-aside Redis layer and designed the TTL and invalidation policy. Our team measured latency before and after the change under a repeatable load test. I can explain my individual contribution, how we measured the result, and why we chose cache-aside over write-through caching. Replace this paragraph with your actual baseline, measured outcome, constraints, and decisions; do not practice claiming invented metrics.
