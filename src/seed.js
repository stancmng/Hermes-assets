// Demo vault content: a small, realistic workspace that exercises outlines,
// tagged records, frontmatter pages, links and every database view.

import { todayISO, addDays } from './util.js';

export function seedFiles() {
  const T = todayISO();
  const d = n => addDays(T, n);
  const files = [];
  const add = (path, content) => files.push({ path, content });

  const task = (title, status, due, priority, project, effort, ind = '  ') => {
    const done = status === 'Done';
    return `${ind}- [${done ? 'x' : ' '}] ${title} #task\n` +
      `${ind}  - status:: ${status}\n${ind}  - due:: ${due}\n${ind}  - priority:: ${priority}\n` +
      `${ind}  - project:: [[${project}]]\n${ind}  - effort:: ${effort}\n`;
  };

  add('Welcome.md', `---
tags: [guide]
---
- **Hermes** keeps your notes as plain markdown files. You get an outliner for writing and a database for everything you tag.
- Outlining
  - \`Enter\` adds a bullet. \`Tab\` and \`Shift+Tab\` indent. \`Alt+↑\` and \`Alt+↓\` move a bullet.
  - Click a bullet dot to zoom into it. Drag the dot to reorder.
  - Type \`#\` to tag, \`[[\` to link a page, \`/\` for commands.
  - \`Ctrl/Cmd+Enter\` turns a bullet into a task and checks it off.
  - \`Ctrl/Cmd+Z\` undoes structure changes too.
- Tags become databases
  - Tag any bullet, then add fields as child bullets written as \`name:: value\`.
  - [ ] Try it: change the status of this task, then open the [[Tasks]] table #task
    - status:: Todo
    - due:: ${d(1)}
    - priority:: Low
    - effort:: 1
  - Open any tag in the sidebar to see every tagged bullet and page in a table or board. Edit cells in place and the markdown updates.
- Your files
  - Everything is saved to disk as you type, in the folder you opened.
  - Edit a file in Obsidian or any editor while Hermes is open and the change appears here within a couple of seconds.
  - Views and column types live in \`.hermes/config.json\` in your vault. Delete it any time.
- Shortcuts
  - \`Ctrl/Cmd+K\` search and jump, \`Alt+N\` new page, \`Alt+D\` today's note, \`Ctrl/Cmd+\\\` toggle sidebar.
`);

  add('Tasks.md', `- All tasks in your vault roll up into one database. Open the **task** tag in the sidebar to filter, sort, group and switch to a board.
- Quick capture
  - Add loose tasks here. Tag them with #task and add a status.
${task('Book travel for offsite', 'Todo', d(9), 'Low', 'Q4 Planning', 2, '  ')}`);

  // ---- projects (pages with frontmatter)
  const projects = [
    ['Hermes Launch', 'Active', 'Ada Lovelace', d(21), 45000, [
      ['Write launch announcement', 'In progress', d(2), 'High', 5],
      ['Finalize pricing page', 'Todo', d(4), 'High', 3],
      ['Record product demo video', 'Todo', d(7), 'Medium', 8],
      ['Set up analytics events', 'Done', d(-3), 'Medium', 3],
      ['Beta feedback triage', 'In progress', d(1), 'High', 5],
    ], ['Goal', 'Ship the public beta to 500 users.', 'Launch checklist is tracked below. Press office briefed by [[Grace Hopper]].']],
    ['Website Redesign', 'Active', 'Grace Hopper', d(35), 28000, [
      ['Audit current site navigation', 'Done', d(-6), 'Medium', 3],
      ['Draft new homepage wireframes', 'In progress', d(3), 'High', 5],
      ['Choose typography and color tokens', 'Todo', d(8), 'Medium', 2],
      ['Migrate blog content', 'Todo', d(18), 'Low', 13],
    ], ['Goal', 'Cut bounce rate by 20% with a faster, clearer site.', 'Design review every Thursday with [[Katherine Johnson]].']],
    ['Q4 Planning', 'Planning', 'Katherine Johnson', d(14), 0, [
      ['Collect team OKR drafts', 'Todo', d(5), 'High', 3],
      ['Budget review with finance', 'Todo', d(10), 'Medium', 5],
      ['Plan the team offsite', 'In progress', d(6), 'Low', 2],
    ], ['Goal', 'Agree on three company OKRs and a hiring plan.', 'Draft shared with [[Alan Turing]] for feedback.']],
    ['Mobile App v2', 'On hold', 'Alan Turing', d(60), 90000, [
      ['Scope offline sync', 'Todo', d(20), 'Medium', 8],
      ['Evaluate push notification vendors', 'Todo', d(15), 'Low', 3],
    ], ['Goal', 'Rebuild the mobile app on the new API.', 'Paused until Q4 planning finishes.']],
  ];
  for (const [name, status, owner, due, budget, tasks, [goalLabel, goal, note]] of projects) {
    add(`Projects/${name}.md`, `---
tags:
  - project
status: ${status}
owner: "[[${owner}]]"
due: ${due}
budget: ${budget}
---
- ${goalLabel}
  - ${goal}
- Notes
  - ${note}
- Tasks
${tasks.map(t => task(t[0], t[1], t[2], t[3], name, t[4])).join('')}`);
  }

  // ---- people
  const people = [
    ['Ada Lovelace', 'Product lead', 'Analytical Engines', 'ada@example.com', d(-4)],
    ['Grace Hopper', 'Head of marketing', 'Compiler Co', 'grace@example.com', d(-10)],
    ['Katherine Johnson', 'Program manager', 'Orbit Labs', 'katherine@example.com', d(-1)],
    ['Alan Turing', 'Engineering director', 'Enigma Systems', 'alan@example.com', d(-20)],
    ['Margaret Hamilton', 'Staff engineer', 'Apollo Software', 'margaret@example.com', d(-35)],
  ];
  for (const [name, role, company, email, last] of people) {
    add(`People/${name}.md`, `---
tags:
  - person
role: ${role}
company: ${company}
email: ${email}
last-contact: ${last}
---
- Context
  - Met through the launch working group.
- Follow ups
  - [ ] Send intro deck to ${name.split(' ')[0]} #task
    - status:: Todo
    - due:: ${d(2)}
    - priority:: Low
    - project:: [[Hermes Launch]]
    - effort:: 1
`);
  }

  // ---- daily notes with meetings
  add(`Daily/${T}.md`, `- Plan for today
  - [ ] Review beta feedback with [[Ada Lovelace]] #task
    - status:: In progress
    - due:: ${T}
    - priority:: High
    - project:: [[Hermes Launch]]
    - effort:: 2
  - [x] Send weekly update #task
    - status:: Done
    - due:: ${T}
    - priority:: Low
    - project:: [[Q4 Planning]]
    - effort:: 1
- Weekly sync #meeting
  - date:: ${T}
  - attendees:: [[Ada Lovelace]], [[Grace Hopper]]
  - outcome:: Launch date confirmed
  - Decisions
    - Move the demo video to next week.
    - Grace owns the press kit.
- Ideas
  - A shared reading list for the team #idea
`);
  add(`Daily/${d(-1)}.md`, `- Design review #meeting
  - date:: ${d(-1)}
  - attendees:: [[Katherine Johnson]], [[Grace Hopper]]
  - outcome:: Homepage direction approved
  - Notes
    - Hero section needs a stronger headline.
- Reading notes
  - Wrote up takeaways from [[Reading List]].
`);
  add(`Daily/${d(-6)}.md`, `- Kickoff #meeting
  - date:: ${d(-6)}
  - attendees:: [[Ada Lovelace]], [[Alan Turing]], [[Margaret Hamilton]]
  - outcome:: Scope and owners agreed
  - Notes
    - Three workstreams: launch, redesign, planning.
`);

  add('Reading List.md', `- Books
  - Deep Work #book
    - author:: Cal Newport
    - status:: Finished
    - rating:: 5
  - The Pragmatic Programmer #book
    - author:: Andrew Hunt
    - status:: Reading
    - rating:: 4
  - Thinking in Systems #book
    - author:: Donella Meadows
    - status:: Queued
    - rating:: 0
  - The Mythical Man-Month #book
    - author:: Fred Brooks
    - status:: Queued
    - rating:: 0
  - Range #book
    - author:: David Epstein
    - status:: Finished
    - rating:: 4
`);
  return files;
}
