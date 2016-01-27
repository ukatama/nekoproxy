FROM node
MAINTAINER ukatama dev.ukatama@gmail.com

ADD package.json    app/package.json
RUN cd app && npm install

ADD beniimo-dev     app/beniimo-dev
ADD src             app/src
RUN mkdir           app/tmp
ADD views           app/views
ADD .babelrc        app/.babelrc
ADD .eslintrc       app/.eslintrc
ADD gulpfile.js     app/gulpfile.js
ADD config-example  app/config-example
ADD config          app/config

RUN cd app && npm run build

ENV NODE_ENV production

ENTRYPOINT cd app && node .
