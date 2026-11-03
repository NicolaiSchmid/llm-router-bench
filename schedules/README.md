# Scheduled targets

Start with an empty list. After manual pilot runs, add reviewed entries:

```json
[{"provider":"openrouter","model":"REPLACE_WITH_AVAILABLE_MODEL","protocol":"chat"}]
```

The placeholder is documentation only. Daily core: one repetition, 100 request
cap. Weekly legacy: one repetition, 300 request cap; native Messages uses core.
For reliability sampling, run a manual repeated core panel and choose sample
size from the observed variance and available budget.
