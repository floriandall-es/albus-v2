import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.routes import (
    auth,
    availability,
    categories,
    health,
    holidays,
    invitations,
    me,
    onboarding,
    pools,
    schedules,
    shift_swaps,
    skills,
    slot_dependencies,
    slots,
    stats,
    team,
    team_bulk,
)

app = FastAPI(title="Trivu API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=r"https?://([a-z0-9-]+\.)?localhost(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(me.router, prefix="/api")
app.include_router(categories.router, prefix="/api")
app.include_router(pools.router, prefix="/api")
app.include_router(skills.router, prefix="/api")
app.include_router(slots.router, prefix="/api")
app.include_router(slot_dependencies.router, prefix="/api")
app.include_router(team.router, prefix="/api")
app.include_router(team_bulk.router, prefix="/api")
app.include_router(invitations.router, prefix="/api")
app.include_router(onboarding.router, prefix="/api")
app.include_router(holidays.router, prefix="/api")
app.include_router(availability.router, prefix="/api")
app.include_router(schedules.router, prefix="/api")
app.include_router(shift_swaps.router, prefix="/api")
app.include_router(stats.router, prefix="/api")

# Serve user-uploaded profile photos. The directory is mounted from a
# host volume in prod (/srv/albus/avatars). We create it on startup so
# fresh dev containers don't 500 on the first request.
os.makedirs(settings.avatars_dir, exist_ok=True)
app.mount(
    "/api/avatars",
    StaticFiles(directory=settings.avatars_dir),
    name="avatars",
)
