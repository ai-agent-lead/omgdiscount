---
type: page
title: "Submit an offer"
description: "Add a program to the list by writing a short post."
timestamp: 2026-11-10
---

## How it works

Each program is one markdown file in content/programs/ in the project repository. Copy the template file, fill in the fields, and open a pull request.

## What the build checks

The site build checks every required field and section. A post with a missing field fails the build and is not published.

## Steps

1. Copy content/programs/_template.md to a new file, named after the program.
2. Fill in the frontmatter and the two body sections.
3. Run the build locally, or let the pull request check run it.
4. Open a pull request. The team reviews the terms before merging.
