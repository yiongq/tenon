# A process tree for the stop (spec 02 §点停止时各状态怎么收「执行命令」; plan step 23, 旧 177):
# this shell keeps SIGTERM's default and dies on it, while its child ignores SIGTERM and lives on
# in the same process group, holding the output pipe. Only a SIGKILL sent to the group after the
# direct child already exited clears the tree. Each process prints `<role> <pid>` once it is set.
/bin/sh -c 'trap "" TERM; echo "child $$"; exec sleep 30' &
echo "parent $$"
wait
