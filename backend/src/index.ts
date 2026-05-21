import { app } from './app.js';

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  // server started
});

export { app };
