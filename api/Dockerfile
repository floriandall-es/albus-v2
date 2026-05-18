FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev curl \
    # WeasyPrint deps for the schedule PDF export. WeasyPrint shells out
    # to these libs at runtime; without them the import works but
    # write_pdf() crashes with a confusing "cairo not found" message.
    libpango-1.0-0 libpangoft2-1.0-0 libcairo2 \
    libgdk-pixbuf-2.0-0 libffi-dev shared-mime-info \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . /app

EXPOSE 8000

CMD ["bash", "-lc", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
